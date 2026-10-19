// On-demand checks and comparisons of project document versions. The index
// worker stores both for every version it reads (proof_check and
// changes_from_previous on document_versions); this runs the same code when
// someone wants what the worker did not store: a version not read yet, or a
// comparison with an older version than the one just before.
//
// Two callers: server.js's GET /documents/check and /documents/compare (the
// project page's preview) and the connector's get_document_checks and
// compare_document_versions (connector/tools/documentInsight.js). Each
// function takes a service-role client and version ids, reads the files
// from storage and answers the result of proofCheck.js or versionCompare.js.
// Nothing here writes.
//
// A refusal is an InsightError: a plain sentence and the HTTP status the
// route answers with. Reading a scan can take minutes, so the caller passes
// a `checkStop` (deadlineStop below) and catches `err.tooLong`.

import { runProofCheck } from "./proofCheck.js";
import { COMPARABLE_EXTENSIONS, compareVersions, readForCompare } from "./versionCompare.js";

/** How long an on-demand read may take before it is left to the worker. */
export const ON_DEMAND_READ_MS = 2 * 60_000;
export const TOO_LONG_MESSAGE = "This file takes too long to read here (it is probably a scan). The server reads it in the background; its checks appear when that finishes.";

export class InsightError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "InsightError";
    this.status = status;
  }
}

/**
 * A checkStop for readForCompare: throws { tooLong: true } once `ms` has
 * passed, and "client gone" once `signal` (if any) is aborted.
 */
export function deadlineStop({ signal = null, ms = ON_DEMAND_READ_MS, now = () => Date.now() } = {}) {
  const deadline = now() + ms;
  return () => {
    if (signal?.aborted) throw new Error("client gone");
    if (now() > deadline) throw Object.assign(new Error("too long"), { tooLong: true });
  };
}

/** The versions' rows, in the order of `ids`; a missing one is a 404. */
async function versionRows(db, ids) {
  const { data: rows, error } = await db
    .from("document_versions")
    .select("id, version_number, storage_path, file_name, matter_document_id")
    .in("id", ids);
  if (error) throw new InsightError(500, "Could not look up the version.");
  const versions = ids.map((id) => (rows ?? []).find((r) => r.id === id));
  if (versions.some((v) => !v)) throw new InsightError(404, "Document version not found");
  return versions;
}

/** One version's file, read the way the worker reads it. */
async function readVersion(db, v, { checkStop, verb }) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(v.storage_path)?.[1] ?? "").toLowerCase();
  if (!COMPARABLE_EXTENSIONS.includes(ext)) throw new InsightError(422, `v${v.version_number} is not a Word, PDF or text file, so it cannot be ${verb}.`);
  const { data: file, error } = await db.storage.from("matter-documents").download(v.storage_path);
  if (error || !file) throw new InsightError(404, `The file for v${v.version_number} is missing from storage.`);
  checkStop();
  return readForCompare(new Uint8Array(await file.arrayBuffer()), `file.${ext}`, { checkStop });
}

/**
 * The proof check of one version, run now on its file.
 * @param {object} db   service-role client
 * @param {string} versionId
 * @param {{ checkStop?: () => void, log?: (line: string) => void }} [options]
 * @returns {Promise<ReturnType<typeof runProofCheck>>}
 */
export async function proofCheckVersion(db, versionId, { checkStop = () => {}, log = () => {} } = {}) {
  const [v] = await versionRows(db, [versionId]);
  const result = runProofCheck(await readVersion(db, v, { checkStop, verb: "checked" }));
  log(`proof check v${v.version_number} (${v.id}): ${result.total} findings`);
  return result;
}

/**
 * What changed from one version of a document to another, compared now from
 * the two files. Both must belong to the same document.
 * @param {object} db   service-role client
 * @param {string} fromId   the earlier version
 * @param {string} toId     the later version
 * @param {{ checkStop?: () => void, log?: (line: string) => void }} [options]
 * @returns {Promise<ReturnType<typeof compareVersions> & { previous: { version_id: string, version_number: number, file_name: string | null } }>}
 */
export async function compareVersionPair(db, fromId, toId, { checkStop = () => {}, log = () => {} } = {}) {
  if (fromId === toId) throw new InsightError(400, "Pick two different versions to compare.");
  const versions = await versionRows(db, [fromId, toId]);
  if (versions[0].matter_document_id !== versions[1].matter_document_id) throw new InsightError(400, "Both versions must belong to the same document.");
  const reads = [];
  for (const v of versions) reads.push(await readVersion(db, v, { checkStop, verb: "compared" }));
  const [from, to] = versions;
  const result = compareVersions(reads[0], reads[1]);
  result.previous = { version_id: from.id, version_number: from.version_number, file_name: from.file_name ?? null };
  log(`compare v${from.version_number} -> v${to.version_number} (${to.matter_document_id}): ${result.shown} shown, ${result.hidden} hidden`);
  return result;
}
