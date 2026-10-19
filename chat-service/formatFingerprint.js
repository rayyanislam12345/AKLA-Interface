// The format fingerprint of a Word file: what a draft of its kind must keep.
// Page set-up per section, fingerprints of the style, numbering, theme, font,
// header and footer parts, the heading styles, the body font and size (as Word
// resolves them, since the firm sets Arial on every run over a Times New
// Roman or Calibri "Normal"), table styles, placeholder and list ids.
// docxChecks.js holds the dependency-free measuring and the gate itself (it
// is shared with an edge function); this file adds unzipping, hashing and a
// cache, so a 4,000-paragraph standard is profiled once per 20 minutes.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { formatProfile, formatGate } from "./docxChecks.js";

const TTL_MS = 20 * 60 * 1000;
const MAX_ENTRIES = 8;
const cache = new Map(); // sha256 → { at, profile, fingerprint }
const dec = new TextDecoder();
const sha256 = data => createHash("sha256").update(data).digest("hex");

/** The XML and relationship parts of a .docx as strings. */
export function docxParts(bytes) {
  const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { filter: f => /\.(xml|rels)$/.test(f.name) });
  return Object.fromEntries(Object.entries(entries).map(([name, b]) => [name, dec.decode(b)]));
}

function cached(hash) {
  const hit = cache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(hash); return null; }
  cache.delete(hash); cache.set(hash, hit); // most recently used last
  return hit;
}
function remember(hash, entry) {
  cache.set(hash, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return entry;
}

/** The gate's profile of a file, cached by the sha256 of its bytes. */
export function formatProfileOf(bytes, { cache: useCache = true } = {}) {
  const hash = sha256(bytes);
  const hit = useCache && cached(hash);
  if (hit) return hit.profile;
  const profile = formatProfile(docxParts(bytes));
  profile.sha256 = hash;
  if (useCache) remember(hash, { at: Date.now(), profile, fingerprint: null });
  return profile;
}

const top = map => [...map].sort((a, b) => b[1] - a[1]);

/** A plain, storable description of the profile (JSON-safe). */
export function fingerprintOf(profile) {
  const headers = {}; const footers = {};
  for (const [name, h] of Object.entries(profile.headerFooter)) (name.includes("header") ? headers : footers)[name.replace(/^word\//, "")] = sha256(h.xml);
  const b = profile.body;
  return {
    sha256: profile.sha256 ?? null,
    sections: profile.sections.map(({ pgSz, pgMar, orient, titlePg, headerRefs, footerRefs }) => ({
      pgSz, pgMar, orient, titlePg,
      headerRefs: headerRefs.map(r => ({ ...r, part: String(r.part).replace(/^word\//, "") })),
      footerRefs: footerRefs.map(r => ({ ...r, part: String(r.part).replace(/^word\//, "") })),
    })),
    parts: {
      styles: sha256(profile.definitions.styles),
      numbering: sha256([...profile.numbering.abstracts.values()].join("") + [...profile.numbering.nums.values()].map(n => n.xml).join("") + profile.numbering.rest),
      theme: sha256(profile.definitions.theme),
      fontTable: sha256(profile.definitions.fontTable),
      headers, footers,
    },
    headingStyles: profile.headingStyles,
    // share is the body size's share of the text: the gate's size rule is
    // "no less than the firm's own file" (some precedents are 90% 11 pt).
    body: {
      font: b.font, fontShare: round(b.fontShare), sizeHalfPts: b.sizeHalfPts, share: round(b.sizeShare),
      chars: b.chars, paragraphs: b.paragraphs.length,
      fonts: Object.fromEntries(top(b.fonts).slice(0, 5).map(([f, n]) => [f, round(n / (b.chars || 1))])),
      sizes: Object.fromEntries(top(b.sizes).slice(0, 5).map(([s, n]) => [s, round(n / (b.chars || 1))])),
    },
    // The header and footer lines filled in for each document (a blank or a
    // date in them): the gate lets their words change, never their look.
    variableHeaderParagraphs: Object.entries(profile.headerFooter).flatMap(([name, h]) => h.paragraphs.map((p, index) => (h.variable?.[index] ? { part: name.replace(/^word\//, ""), index } : null)).filter(Boolean)),
    tableStyles: top(b.tableStyles).map(([s]) => s),
    placeholder: top(b.placeholders)[0]?.[0] ?? null,
    numIds: [...b.numIds].sort((x, y) => Number(x) - Number(y)),
    numbering: { abstractNums: profile.numbering.abstracts.size, nums: profile.numbering.nums.size },
  };
}
const round = n => Math.round(n * 10000) / 10000;

/** fingerprint(bytes) per the drafting plan, Appendix C. Cached 20 minutes. */
export function fingerprint(bytes) {
  const profile = formatProfileOf(bytes);
  const hit = cached(profile.sha256);
  if (hit?.fingerprint) return hit.fingerprint;
  const fp = fingerprintOf(profile);
  if (hit) hit.fingerprint = fp;
  return fp;
}

/**
 * The format gate on Word bytes: the draft against the firm's file for its
 * kind. opts as formatGate (base: the file's name for the reply line,
 * variableParagraphs: header/footer lines that may change). The base's
 * profile is cached; the draft's is not.
 */
export function gateFormat(outBytes, baseBytes, opts = {}) {
  const started = performance.now();
  const base = formatProfileOf(baseBytes);
  const out = formatProfileOf(outBytes, { cache: false });
  return { ...formatGate(out, base, opts), ms: Math.round(performance.now() - started) };
}

/**
 * The reply line: "Format matches the firm's standard (ADB68)" or what
 * differs. `subject` names what the draft was compared with when that is
 * not the firm's standard (an edit is compared with the version edited).
 */
export function formatLine(result, subject = "the firm's standard") {
  const name = result.base ? ` (${result.base})` : "";
  if (result.status === "matches") return `Format matches ${subject}${name}.`;
  return `Format differs from ${subject}${name}: ${result.findings.join("; ")}.`;
}

// ---------------------------------------------------------------- fill paths
// Every path that files a Word draft or edit (the Hub's fill and edit turns,
// the guided drafting's working copy, the connector's fill) runs the gate on
// the finished bytes against the file it came from, through checkFormat.
// FORMAT_GATE in the environment is the safety switch: "enforce" (the
// default, and what any other value means) refuses a file that drifts;
// "report" files it anyway and says what differs, as a warning.

export const FORMAT_GATE_MODES = Object.freeze(["enforce", "report"]);
/** The gate's mode from the environment, read on every call so a restart is all a change needs. */
export function formatGateMode(env = process.env) {
  return String(env?.FORMAT_GATE ?? "").trim().toLowerCase() === "report" ? "report" : "enforce";
}
export const FORMAT_REFUSED_SENTENCE = "Nothing was saved, because a draft is filed only in the firm's own format; ask again without the change that caused this (typed clause numbers are the usual cause), or tell the Hub's owner if it keeps happening.";
/** The guided drafting's first save is the standard with its own tracked changes accepted: nothing the lawyer asked for, so asking again cannot help. */
export const STANDARD_REFUSED_SENTENCE = "The firm's standard carries tracked changes that alter its layout once accepted, so no working copy was made; ask the Hub's owner to accept or reject them in the standard and upload it again.";
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** A file name as the reply names it: no folder, no .docx. */
export const baseName = (fileName) => String(fileName ?? "").split("/").pop().replace(/\.docx$/i, "").trim() || null;

/**
 * The gate as a fill path runs it. Returns { result, mode, refused, text }:
 * `refused` is true only for drift in enforce mode (nothing may be stored);
 * `text` is what the reply says — the format line on a match, the findings
 * as a short list and one sentence on a refusal, the same list as a warning
 * in report mode. A gate that cannot run (a file it cannot read) refuses
 * nothing: the reply says the check did not run.
 * @param outBytes  the bytes about to be stored
 * @param baseBytes the file they came from (the firm's standard, or the version edited)
 * @param opts { base: file name, subject?: "the firm's standard", variableParagraphs?, mode?, refusedSentence? }
 *   variableParagraphs: header and footer lines this change was asked to
 *   alter (variableLinesFor); lines of the base holding a blank or a date
 *   are variable without it. refusedSentence ends a refusal (the default
 *   asks the lawyer to try again without the change).
 */
export function checkFormat(outBytes, baseBytes, { base = null, subject = "the firm's standard", variableParagraphs, mode = formatGateMode(), refusedSentence = FORMAT_REFUSED_SENTENCE } = {}) {
  const name = baseName(base);
  const reference = subject === "the firm's standard" ? "the firm's file" : subject;
  let result;
  try {
    result = gateFormat(outBytes, baseBytes, { base: name ?? undefined, reference, ...(variableParagraphs?.length ? { variableParagraphs } : {}) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { result: { status: "error", base: name, findings: [], error: reason }, mode, refused: false, text: `The format check could not run (${reason}), so this file has not been compared with ${subject}; check its layout in Word before it goes out.` };
  }
  if (result.status === "matches") {
    const notes = result.notes?.length ? ` (Note: ${result.notes.join("; ")}.)` : "";
    return { result, mode, refused: false, text: `${formatLine(result, subject)}${notes}` };
  }
  const where = name ? ` (${name})` : "";
  const list = result.findings.map((f) => `- ${sentence(f)}`).join("\n");
  if (mode === "enforce") {
    return { result, mode, refused: true, text: `The format check found that this file differs from ${subject}${where}:\n${list}\n${refusedSentence}` };
  }
  return { result, mode, refused: false, text: `Warning: the format differs from ${subject}${where}, and the file was saved anyway because the format check is set to report only:\n${list}` };
}

/** What a stored row keeps of a check: small and JSON-safe. */
export const formatRecord = (check) => ({ status: check.result.status, base: check.result.base ?? null, findings: check.result.findings ?? [], mode: check.mode, ...(check.result.ms != null ? { ms: check.result.ms } : {}) });

export function clearFingerprintCache() { cache.clear(); }

/**
 * The header and footer lines a change list was asked to alter, as the
 * gate's variableParagraphs: { part, text } for each operation on a
 * paragraph of a header or footer part (inspectDocx's byRef). The text is
 * the paragraph's longest stretch between tabs and line breaks, which the
 * gate finds inside the base paragraph's own text.
 */
export function variableLinesFor(ops, byRef) {
  const lines = [];
  for (const op of ops ?? []) {
    const ref = byRef?.get?.(Number(op?.p));
    if (!ref || !/^word\/(header|footer)\d+\.xml$/.test(ref.part ?? "")) continue;
    const text = String(ref.exactText ?? "").split(/[\t\n]+/).map((t) => t.trim()).sort((a, b) => b.length - a.length)[0];
    if (text) lines.push({ part: ref.part, text });
  }
  return lines;
}

/**
 * Gate, then store: what every Hub path that files a Word copy does with a
 * checkFormat result. A refusal stores nothing (store is never called) and
 * its text is sent; otherwise store() runs, and when it stored a copy (a
 * truthy result) the format line, or the report-mode warning, is sent after
 * it. Returns { refused, stored, appended }: `appended` is the text added
 * to the reply ("" when nothing was).
 * @param check  checkFormat's result, or null when nothing was changed (no gate)
 * @param store  async () => the stored copy, or a falsy value when nothing was stored
 * @param send   (event, payload) => void, the reply stream
 */
export async function storeUnlessRefused(check, store, send = () => {}) {
  if (check?.refused) {
    const appended = `\n\n${check.text}`;
    send("delta", { text: appended });
    return { refused: true, stored: null, appended };
  }
  const stored = await store();
  if (!stored || !check) return { refused: false, stored, appended: "" };
  const appended = `\n\n${check.text}`;
  send("delta", { text: appended });
  return { refused: false, stored, appended };
}

/**
 * The guided drafting's first save: the standard with its own tracked
 * changes accepted, checked against the standard before it is stored. A
 * refusal stores nothing and ends with STANDARD_REFUSED_SENTENCE (the
 * lawyer asked for nothing, so asking again cannot help).
 * Returns { format, bytes, stored }: stored is store()'s result, or null.
 * @param standardBytes the firm's standard as downloaded
 * @param opts { base: its file name, accept: bytes => bytes, store: async (bytes, format) => row, mode? }
 */
export async function openWorkingCopy(standardBytes, { base, accept, store, mode }) {
  const bytes = accept(standardBytes);
  const format = checkFormat(bytes, standardBytes, { base, refusedSentence: STANDARD_REFUSED_SENTENCE, ...(mode ? { mode } : {}) });
  if (format.refused) return { format, bytes, stored: null };
  return { format, bytes, stored: await store(bytes, format) };
}
