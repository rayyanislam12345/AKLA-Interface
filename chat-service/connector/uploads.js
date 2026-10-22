// Files from a claude.ai chat into a Hub project (upload_file_to_project,
// connector/tools/uploads.js). claude.ai hands a tool only text, so a Word
// draft the lawyer attached, or a file Claude built in its code sandbox with
// a skill, reaches the Hub one of two ways:
//
//   - small files (MAX_INLINE_BYTES) as base64 in the tool call itself;
//   - anything up to MAX_UPLOAD_BYTES through a one-time upload address on
//     the connector's own origin, https://aklachat.duckdns.org/mcp/upload/<token>.
//     POST takes the file (raw body or multipart: `curl -F file=@x.docx`
//     from Claude's sandbox); GET is a plain drop page the lawyer opens when
//     the sandbox cannot reach the network.
//
// The address lives under /mcp/ because Caddy already sends /mcp/* to this
// process (chat-service/Caddyfile); a path of its own would need a Caddy
// change on the VM first. Caddy sets no limit on a request body.
//
// The owner's decision (22 Oct 2026): "allow the file upload, no need for
// safety". The token in the address is the authority: no sign-in on the
// page. It is bound to the lawyer who asked for it, the project, the target
// document and the file name, lasts ADDRESS_TTL_MS, and files once: a
// refused or failed attempt (wrong type, too large, the save failed) leaves
// it usable so the lawyer can try again with the right file. At the moment
// of the upload the lawyer must still be a firm member and their connector
// sign-in not withdrawn (ctx.recheck below), and the write caps apply as
// for every other save.
//
// The pending addresses are kept in this process only, so a connector
// restart (every deploy) voids an address not yet used; the tool says so.
// A file that did arrive stays findable after a restart: its storage key is
// "<uploadId>-<name>" (saveVersion's storageKeyId), and get_upload looks it
// up there. No table of its own, so no migration.
//
// The save is projectWrites.saveVersion as for every other write: the
// lawyer's own version (not AI-generated), labelled "Uploaded from
// claude.ai — <date>" unless the lawyer gave a label, recorded in
// connector_actions against the lawyer, and indexed by the database's own
// trigger on document_versions like any upload from the site.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MAX_LABEL_CHARS, MAX_STORED_BYTES, MAX_TITLE_CHARS, SIGN_IN_ENDED_SENTENCE } from "./projectWrites.js";
import { DEFAULT_HUB_URL, hubBase, hubLink } from "./hubLinks.js";
import { escapeHtml } from "./pages.js";

export const UPLOAD_TOOL = "upload_file_to_project";
export const STATUS_TOOL = "get_upload";
/** Supabase Storage's per-file limit on this project (50 MiB): nothing larger can be stored. */
export const MAX_UPLOAD_BYTES = MAX_STORED_BYTES;
/** contentBase64 in the tool call: Claude writes every character of it out, so only small files. */
export const MAX_INLINE_BYTES = 1024 * 1024;
export const ADDRESS_TTL_MS = 30 * 60 * 1000;
/** Where the addresses live on the connector's origin (Caddy routes /mcp/* here). */
export const UPLOAD_PATH = "/mcp/upload/";
/** Live addresses one lawyer may hold at once, and the process as a whole. */
export const MAX_OPEN_PER_USER = 20;
const MAX_ENTRIES = 5000;
/**
 * Files being received at once: each is held in memory whole (up to 50 MB,
 * briefly twice while its chunks are joined) under the unit's 1 GB, beside
 * a fill of a long standard at about 500 MB (fillStandardWrite.js).
 */
export const MAX_RECEIVING = 2;
/** How long a used or expired address is remembered, so get_upload and the page can still say what happened. */
const REMEMBER_MS = 12 * 60 * 60 * 1000;
/** A multipart body carries its headers and boundaries on top of the file. */
const MULTIPART_SLACK = 1024 * 1024;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// The kinds the owner allowed: Word, PDF, Excel, PowerPoint, images and
// text. `sig` is how the file's first bytes must look, so a .docx address
// that is sent an error page or a PDF says so instead of filing nonsense.
export const UPLOAD_TYPES = Object.freeze({
  docx: { kind: "Word", mime: DOCX, sig: "zip" },
  doc: { kind: "Word", mime: "application/msword", sig: "ole" },
  rtf: { kind: "Word", mime: "application/rtf", sig: "rtf" },
  pdf: { kind: "PDF", mime: "application/pdf", sig: "pdf" },
  xlsx: { kind: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sig: "zip" },
  xls: { kind: "Excel", mime: "application/vnd.ms-excel", sig: "ole" },
  csv: { kind: "text", mime: "text/csv", sig: "text" },
  pptx: { kind: "PowerPoint", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sig: "zip" },
  ppt: { kind: "PowerPoint", mime: "application/vnd.ms-powerpoint", sig: "ole" },
  png: { kind: "image", mime: "image/png", sig: "png" },
  jpg: { kind: "image", mime: "image/jpeg", sig: "jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg", sig: "jpeg" },
  gif: { kind: "image", mime: "image/gif", sig: "gif" },
  webp: { kind: "image", mime: "image/webp", sig: "webp" },
  heic: { kind: "image", mime: "image/heic", sig: "ftyp" },
  tif: { kind: "image", mime: "image/tiff", sig: "tiff" },
  tiff: { kind: "image", mime: "image/tiff", sig: "tiff" },
  txt: { kind: "text", mime: "text/plain", sig: "text" },
  md: { kind: "text", mime: "text/markdown", sig: "text" },
});
/** The kinds the index worker reads for search (indexing/extract.js SUPPORTED_EXTENSIONS); the rest are stored, not searched. */
const SEARCHABLE = new Set(["pdf", "docx", "xlsx", "xls", "pptx", "txt", "md", "csv"]);
export const TYPES_SENTENCE = `The Hub takes Word, PDF, Excel, PowerPoint, image and text files (${Object.keys(UPLOAD_TYPES).map((e) => `.${e}`).join(", ")})`;

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Karachi" });
const mb = (n) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const fail = (status, message) => Object.assign(new Error(message), { status });

/** "x.DOCX" -> "docx"; "" when there is none. */
export const extensionOf = (name) => (/\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? "").trim())?.[1] ?? "").toLowerCase();
const sameKind = (a, b) => a === b || (["jpg", "jpeg"].includes(a) && ["jpg", "jpeg"].includes(b)) || (["tif", "tiff"].includes(a) && ["tif", "tiff"].includes(b));

/**
 * A file name the Hub can file, or a one-sentence refusal: a name, one of
 * the allowed extensions, no path. Returns { fileName, extension, type }.
 */
export function checkFileName(value) {
  const name = String(value ?? "").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) throw fail(400, "fileName is needed: the file's name with its extension, e.g. \"Share Purchase Agreement.docx\".");
  if (name.length > MAX_TITLE_CHARS) throw fail(400, `fileName is longer than ${MAX_TITLE_CHARS} characters; shorten it.`);
  const extension = extensionOf(name);
  if (!extension || !name.slice(0, -(extension.length + 1)).trim()) throw fail(400, "fileName needs a name and an extension, e.g. \"Share Purchase Agreement.docx\".");
  const type = UPLOAD_TYPES[extension];
  if (!type) throw fail(415, `${TYPES_SENTENCE}; a .${extension} file cannot be filed.`);
  return { fileName: name, extension, type };
}

/** The title a new document gets when none is given: the file's name without its extension. */
export const titleFromFileName = (fileName) => String(fileName ?? "").replace(/\.[A-Za-z0-9]{1,10}$/, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) || "Uploaded file";

/** The version's label: the lawyer's own with the source added, or "Uploaded from claude.ai — 22 October 2026". */
export function uploadLabel(label, at = new Date()) {
  const own = String(label ?? "").replace(/\s+/g, " ").trim();
  const suffix = " — uploaded from claude.ai";
  if (own) return own.length + suffix.length > MAX_LABEL_CHARS ? `${own.slice(0, MAX_LABEL_CHARS - suffix.length - 1)}…${suffix}` : `${own}${suffix}`;
  return `Uploaded from claude.ai — ${dateFmt.format(at)}`;
}

/** Whether the bytes look like the kind the extension names; text must carry no NUL bytes. */
export function looksLike(bytes, extension) {
  const b = bytes;
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i, s) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  switch (UPLOAD_TYPES[extension]?.sig) {
    case "zip": return at(0, 0x50, 0x4b, 0x03, 0x04);
    case "ole": return at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "rtf": return ascii(0, "{\\rtf");
    case "pdf": return Buffer.from(b.subarray(0, 1024)).includes("%PDF-");
    case "png": return at(0, 0x89, 0x50, 0x4e, 0x47);
    case "jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "gif": return ascii(0, "GIF8");
    case "webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "ftyp": return ascii(4, "ftyp");
    case "tiff": return at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a);
    case "text": return !b.subarray(0, 8192).includes(0);
    default: return false;
  }
}

/**
 * The file in a multipart/form-data body: the part named "file", else the
 * first part that carries a filename, else null. A small parser of our own
 * rather than undici's, whose multipart support differs across Node 20's
 * point releases. Returns { bytes, fileName, mime }.
 */
export function fileFromMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ""));
  if (!m) return null;
  const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const from = start + delimiter.length;
    if (body[from] === 0x2d && body[from + 1] === 0x2d) break; // the closing "--"
    const next = body.indexOf(delimiter, from);
    if (next < 0) break;
    // Each part: CRLF, headers, CRLF CRLF, content, CRLF before the next delimiter.
    const part = body.subarray(from + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    if (split >= 0) {
      const headers = part.subarray(0, split).toString("utf8");
      const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? "";
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null;
      const star = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(disposition)?.[1];
      let fileName = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
      if (star) { try { fileName = decodeURIComponent(star.trim().replace(/^"|"$/g, "")); } catch { /* keep the plain one */ } }
      const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? null;
      parts.push({ name, fileName, mime, bytes: part.subarray(split + 4) });
    }
    start = next;
  }
  return parts.find((p) => p.name === "file") ?? parts.find((p) => p.fileName != null) ?? null;
}

/**
 * Files `bytes` into the project through the write foundation: the caps
 * first (the sign-in afresh), the type and size checked, saveVersion as the
 * lawyer, one connector_actions row whatever happened, the caps released.
 * The same for the base64 path (ctx is the tool's) and the address (ctx is
 * the one the address carries). `target` is { projectId, projectName,
 * documentId, documentTitle, title, fileName, extension, label }.
 * Returns the saved version's facts and the lines to answer with.
 */
export async function fileUpload({ writes, ctx, target, bytes, sentName = null, storageKeyId = null, hubUrl = DEFAULT_HUB_URL, now = () => new Date(), log = () => {} }) {
  const record = (fields) => writes.recordAction(ctx, { tool: UPLOAD_TOOL, projectId: target.projectId, documentId: target.documentId ?? null, ...fields }).catch((err) => log(`${UPLOAD_TOOL}: the record could not be written: ${err?.message ?? err}`));
  const caps = await writes.checkCaps(ctx);
  try {
    // The address names the file; a different kind sent to it is refused,
    // so the document on the Hub is what the lawyer and Claude agreed on.
    const sentExtension = sentName ? extensionOf(sentName) : "";
    if (sentExtension && !sameKind(sentExtension, target.extension)) {
      await record({ outcome: "refused" });
      throw fail(415, UPLOAD_TYPES[sentExtension]
        ? `This address is for a .${target.extension} file (${target.fileName}) and a .${sentExtension} file was sent; nothing was filed. Ask Claude for a new address with that file's name.`
        : `${TYPES_SENTENCE}; a .${sentExtension} file cannot be filed.`);
    }
    if (!bytes?.length) { await record({ outcome: "refused" }); throw fail(400, "The file is empty; nothing was filed."); }
    if (bytes.length > MAX_UPLOAD_BYTES) { await record({ outcome: "refused" }); throw fail(413, `The file is ${mb(bytes.length)}; the Hub takes at most ${mb(MAX_UPLOAD_BYTES)} a file. Nothing was filed.`); }
    if (!looksLike(bytes, target.extension)) {
      await record({ outcome: "refused" });
      throw fail(415, `That is not a ${UPLOAD_TYPES[target.extension].kind} (.${target.extension}) file, though its name says so; nothing was filed. Send the file itself.`);
    }
    let saved;
    try {
      saved = await writes.saveVersion({
        ctx, projectId: target.projectId, title: target.documentId ? target.documentTitle ?? target.title : target.title,
        matterDocumentId: target.documentId ?? null, bytes, fileName: target.fileName, mime: UPLOAD_TYPES[target.extension].mime,
        labelVerbatim: uploadLabel(target.label, now()), storageKeyId, maxBytes: MAX_UPLOAD_BYTES,
      });
    } catch (err) {
      await record({ outcome: "failed" });
      throw err;
    }
    await record({ documentId: saved.matterDocumentId, versionId: saved.versionId, label: saved.label, outcome: "saved" });
    const site = hubBase(hubUrl);
    const shown = saved.created ? target.title : target.documentTitle ?? target.title;
    const where = saved.created ? `a new document on ${target.projectName}` : `its next version on ${target.projectName}`;
    const lines = [
      `Filed "${shown}" as v${saved.versionNumber} (${saved.fileName}), ${where}, labelled "${saved.label}".`,
      `documentId: ${saved.matterDocumentId}`,
      `versionId: ${saved.versionId}`,
      `Open in Hub: ${hubLink("version", saved.versionId, site)}`,
      `Project ${target.projectName} — Open in Hub: ${hubLink("project", target.projectId, site)}`,
      SEARCHABLE.has(target.extension)
        ? "On file; the Hub is reading it now (get_document_summary on the version in about a minute). It can be marked up (show_document_paragraphs, apply_tracked_changes) or reviewed (start_review) at once if it is a Word file."
        : `On file. The Hub stores ${UPLOAD_TYPES[target.extension].kind} files of this kind (.${target.extension}) but does not read them for search.`,
      "Filed as the lawyer's own version (not marked AI-generated); filing is not legal approval.",
    ];
    return { saved, lines, text: lines.join("\n") };
  } finally {
    caps.release();
  }
}

/** A request body as bytes, refused past `limit` (413) before more is read. */
async function readBytes(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw fail(413, `The file is larger than the ${mb(MAX_UPLOAD_BYTES)} the Hub takes; nothing was filed.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, `The file is larger than the ${mb(MAX_UPLOAD_BYTES)} the Hub takes; nothing was filed.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The one-time upload addresses: issued by the tool, redeemed by the HTTP
 * route app.js sends /mcp/upload/<token> to, looked up by get_upload.
 *
 * @param {object} deps
 * @param {object} deps.writes      connector/projectWrites.js (the same instance the tools use, so the caps' in-flight count is shared)
 * @param {string} deps.issuer      the connector's public origin (https://aklachat.duckdns.org)
 * @param {Function} deps.isMember  (userId) -> Promise<boolean>, asked at the upload
 * @param {object} [deps.store]     connector/store.js; its familyLive says whether the lawyer's connector sign-in still stands
 * @param {string} [deps.hubUrl]
 * @param {Function} [deps.now]     () -> Date
 * @param {Function} [deps.log]
 */
export function createUploads({ writes, issuer, isMember, store = null, hubUrl = DEFAULT_HUB_URL, now = () => new Date(), log = () => {} }) {
  const base = String(issuer ?? "").replace(/\/+$/, "");
  const site = hubBase(hubUrl);
  const byToken = new Map(); // sha256(token) -> entry
  const byId = new Map(); // uploadId -> entry
  let receiving = 0;
  const t = () => now().getTime();

  const prune = () => {
    const at = t();
    for (const [hash, e] of byToken) {
      if (e.state !== "receiving" && at - Math.max(e.expiresAt, e.arrivedAt ?? 0) > REMEMBER_MS) { byToken.delete(hash); byId.delete(e.uploadId); }
    }
  };
  const addressOf = (token) => `${base}${UPLOAD_PATH}${token}`;
  const until = (ms) => `${timeFmt.format(new Date(ms))} Pakistan time`;

  /**
   * A new address for `target` (checked by the tool: the project exists,
   * the document is on it, the file name is allowed), bound to the lawyer
   * in ctx. Returns { uploadId, address, expiresAt }.
   */
  function issue(ctx, target) {
    const userId = uuid(ctx?.userId);
    if (!userId) throw new Error(SIGN_IN_ENDED_SENTENCE);
    prune();
    const at = t();
    const open = [...byId.values()].filter((e) => e.userId === userId && e.state === "waiting" && e.expiresAt > at).length;
    if (open >= MAX_OPEN_PER_USER) throw new Error(`You have ${open} upload addresses waiting for a file, which is the limit; use one of them, or wait for them to expire (${ADDRESS_TTL_MS / 60000} minutes).`);
    if (byToken.size >= MAX_ENTRIES) throw new Error("The connector is holding too many upload addresses just now; try again in a few minutes.");
    const token = randomBytes(24).toString("base64url");
    const entry = {
      uploadId: randomUUID(), userId, clientId: typeof ctx?.clientId === "string" ? ctx.clientId : null,
      familyId: typeof ctx?.familyId === "string" ? ctx.familyId : null, scope: String(ctx?.scope ?? ""),
      ...target, createdAt: at, expiresAt: at + ADDRESS_TTL_MS, state: "waiting", result: null, arrivedAt: null,
    };
    byToken.set(sha256(token), entry);
    byId.set(entry.uploadId, entry);
    log(`upload address ${entry.uploadId} for ${userId}: ${target.fileName} -> ${target.projectId}${target.documentId ? ` / ${target.documentId}` : " (new document)"}`);
    return { uploadId: entry.uploadId, address: addressOf(token), expiresAt: entry.expiresAt, until: until(entry.expiresAt) };
  }

  /** What get_upload says about one id, for its own lawyer only: null when this process does not know it. */
  function statusOf(uploadId, userId) {
    const e = byId.get(String(uploadId ?? "").trim().toLowerCase());
    if (!e || e.userId !== uuid(userId)) return null;
    const at = t();
    if (e.state === "arrived") return { state: "arrived", entry: e, result: e.result };
    if (e.state === "receiving") return { state: "receiving", entry: e };
    if (e.expiresAt <= at) return { state: "expired", entry: e, until: until(e.expiresAt) };
    return { state: "waiting", entry: e, until: until(e.expiresAt), minutesLeft: Math.max(1, Math.ceil((e.expiresAt - at) / 60000)) };
  }

  // The lawyer behind an address, as the write foundation wants them: the
  // caps' recheck asks, at the moment of the upload, that they are still a
  // firm member and that their connector sign-in has not been withdrawn.
  const ctxOf = (e) => ({
    userId: e.userId, clientId: e.clientId, scope: e.scope, canWrite: true,
    recheck: async () => {
      if ((await isMember(e.userId)) !== true) return null;
      if (e.familyId && typeof store?.familyLive === "function" && !(await store.familyLive(e.familyId, now()))) return null;
      return { userId: e.userId, scope: e.scope };
    },
  });

  const send = (res, status, body, type) => {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  };
  const page = (res, status, html) => send(res, status, html, "text/html; charset=utf-8");
  // curl (Claude's sandbox) reads plain lines; the drop page asks for JSON.
  const answer = (req, res, status, payload) => {
    if (/application\/json/i.test(String(req.headers.accept ?? ""))) return send(res, status, JSON.stringify(payload), "application/json");
    return send(res, status, `${payload.ok ? payload.text : `Not filed: ${payload.error}`}\n`, "text/plain; charset=utf-8");
  };

  /** Where an address stands: { entry } or { status, message } for a page or an answer. */
  function lookup(token) {
    const e = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? byToken.get(sha256(token)) : null;
    if (!e) return { status: 404, title: "This upload address is not valid", message: "It may be mistyped, more than half an hour old, or made before the connector was last restarted. Ask Claude in your chat for a new upload address." };
    if (e.state === "arrived") return { status: 409, entry: e, title: "This file is already filed", message: "An upload address files one file, once." };
    if (e.expiresAt <= t()) return { status: 410, entry: e, title: "This upload address has expired", message: `It was open until ${until(e.expiresAt)}. Ask Claude in your chat for a new one.` };
    return { entry: e };
  }

  /** app.js hands every /mcp/upload/<token> request here. */
  async function handle(req, res, token) {
    prune();
    const found = lookup(String(token ?? ""));
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
    if (req.method === "GET" || req.method === "HEAD") {
      if (!found.entry || found.status === 410) return page(res, found.status, messagePage(found.title, found.message));
      if (found.status === 409) return page(res, 200, donePage(found.entry, site));
      return page(res, 200, dropPage(found.entry, until(found.entry.expiresAt)));
    }
    if (req.method !== "POST" && req.method !== "PUT") return answer(req, res, 405, { ok: false, error: "Send the file with POST, or open this address in a browser." });
    if (!found.entry || found.status) {
      // Drain nothing: the connection closes with the answer.
      const extra = found.status === 409 && found.entry?.result ? ` ${found.entry.result.text.split("\n").find((l) => l.startsWith("Open in Hub:")) ?? ""}` : "";
      return answer(req, res, found.status, { ok: false, error: `${found.title}. ${found.message}${extra}`.trim() });
    }
    const e = found.entry;
    if (e.state === "receiving") return answer(req, res, 409, { ok: false, error: "A file is arriving at this address now; wait for it to finish." });
    if (receiving >= MAX_RECEIVING) return answer(req, res, 503, { ok: false, error: "The connector is taking other files just now; try again in a minute." });
    e.state = "receiving";
    receiving += 1;
    try {
      const body = await readBytes(req, MAX_UPLOAD_BYTES + MULTIPART_SLACK);
      const type = String(req.headers["content-type"] ?? "");
      let bytes = body;
      let sentName = null;
      if (/^multipart\/form-data/i.test(type)) {
        const part = fileFromMultipart(body, type);
        if (!part) throw fail(400, "No file was found in the form; send it as the field \"file\" (curl -F file=@path).");
        bytes = part.bytes;
        sentName = part.fileName || null;
      } else {
        const header = req.headers["x-file-name"];
        if (typeof header === "string" && header.trim()) { try { sentName = decodeURIComponent(header.trim()); } catch { sentName = header.trim(); } }
      }
      const out = await fileUpload({ writes, ctx: ctxOf(e), target: e, bytes, sentName, storageKeyId: e.uploadId, hubUrl: site, now, log });
      e.state = "arrived";
      e.arrivedAt = t();
      e.result = { documentId: out.saved.matterDocumentId, versionId: out.saved.versionId, versionNumber: out.saved.versionNumber, fileName: out.saved.fileName, label: out.saved.label, created: out.saved.created, text: out.text };
      log(`upload ${e.uploadId} for ${e.userId}: filed v${out.saved.versionNumber} of ${out.saved.matterDocumentId} (${bytes.length} bytes)`);
      return answer(req, res, 200, { ok: true, text: `${out.text}\nuploadId: ${e.uploadId}`, documentId: e.result.documentId, versionId: e.result.versionId, versionNumber: e.result.versionNumber, hubUrl: hubLink("version", e.result.versionId, site), projectUrl: hubLink("project", e.projectId, site) });
    } catch (err) {
      // Not filed: the address stays usable for the right file until it expires.
      if (e.state === "receiving") e.state = "waiting";
      const message = err instanceof Error ? err.message : String(err);
      const status = err?.status ?? (/limit/i.test(message) ? 429 : /newer version/i.test(message) ? 409 : /sign-in|withdrawn|firm member|read-only/i.test(message) ? 403 : 502);
      log(`upload ${e.uploadId} for ${e.userId} not filed (${status}): ${message}`);
      return answer(req, res, status, { ok: false, error: message });
    } finally {
      receiving -= 1;
    }
  }

  return { issue, statusOf, handle, addressOf };
}

// ---------------------------------------------------------------------------
// The drop page: the firm's navy and gold, one column, works on a phone.
// One inline script sends the file as the request body with its name in a
// header and shows the progress; nothing is loaded from elsewhere.

const STYLE = `
  :root { color-scheme: light; --navy: #1F3864; --gold: #B8902C; --ink: #1b2430; --muted: #5b6573; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f5f7; color: var(--ink); }
  header { background: var(--navy); color: #fff; padding: 14px 20px; border-bottom: 3px solid var(--gold); font-weight: 600; letter-spacing: .02em; }
  main { max-width: 560px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(16, 24, 40, .08); padding: 24px 22px; }
  h1 { font-size: 20px; margin: 0 0 6px; color: var(--navy); }
  p { margin: 8px 0; }
  .muted { color: var(--muted); font-size: 14px; }
  .file { font-weight: 600; word-break: break-word; }
  #drop { display: block; margin-top: 16px; border: 2px dashed #b9c3d3; border-radius: 12px; padding: 32px 16px; text-align: center; cursor: pointer; transition: background .15s, border-color .15s; }
  #drop.over { background: #eef2f9; border-color: var(--navy); }
  #drop strong { color: var(--navy); }
  button { margin-top: 16px; width: 100%; padding: 12px; font-size: 16px; font-weight: 600; color: #fff; background: var(--navy); border: 0; border-radius: 8px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .bar { margin-top: 16px; height: 8px; background: #e4e8ef; border-radius: 4px; overflow: hidden; display: none; }
  .bar span { display: block; height: 100%; width: 0; background: var(--gold); transition: width .2s; }
  .msg { margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 15px; display: none; word-break: break-word; }
  .msg.ok { display: block; background: #eef7ee; color: #1B4614; }
  .msg.err { display: block; background: #fdecec; color: #8a1c1c; }
  .msg a { color: var(--navy); font-weight: 600; }
`;

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header>AKLA Hub</header><main><div class="card">${body}</div></main></body></html>`;

function messagePage(title, message) {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

function donePage(e, site) {
  const r = e.result ?? {};
  const link = r.versionId ? hubLink("version", r.versionId, site) : hubLink("project", e.projectId, site);
  return shell("Already filed", `<h1>This file is already filed</h1>
<p><span class="file">${escapeHtml(r.fileName ?? e.fileName)}</span> is on <strong>${escapeHtml(e.projectName)}</strong>${r.versionNumber ? ` as version ${r.versionNumber}` : ""}.</p>
<p><a href="${escapeHtml(link)}">Open it in the Hub</a></p>
<p class="muted">An upload address files one file, once. For another file, ask Claude in your chat for a new address.</p>`);
}

function dropPage(e, until) {
  const what = e.documentId
    ? `as the next version of <strong>${escapeHtml(e.documentTitle ?? e.title)}</strong>`
    : `as a new document, <strong>${escapeHtml(e.title)}</strong>`;
  const accept = Object.keys(UPLOAD_TYPES).filter((x) => sameKind(x, e.extension)).map((x) => `.${x}`).join(",");
  return shell("Upload a file to AKLA Hub", `<h1>Upload a file to ${escapeHtml(e.projectName)}</h1>
<p>This page files <span class="file">${escapeHtml(e.fileName)}</span> ${what}. It is the version you upload, filed under your name.</p>
<p class="muted">It works once, for a .${escapeHtml(e.extension)} file of up to ${mb(MAX_UPLOAD_BYTES)}, until ${escapeHtml(until)}.</p>
<label id="drop" for="pick"><strong>Drop the file here</strong><br><span class="muted">or tap to choose it</span></label>
<input id="pick" type="file" accept="${escapeHtml(accept)}" hidden>
<button id="send" disabled>Upload</button>
<div class="bar" id="bar"><span id="fill"></span></div>
<div class="msg" id="msg" role="status" aria-live="polite"></div>
<script>
(function () {
  var file = null, drop = document.getElementById("drop"), pick = document.getElementById("pick"), btn = document.getElementById("send");
  var bar = document.getElementById("bar"), fill = document.getElementById("fill"), msg = document.getElementById("msg");
  function say(kind, html) { msg.className = "msg " + kind; msg.innerHTML = html; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function choose(f) { if (!f) return; file = f; btn.disabled = false; drop.innerHTML = "<strong>" + esc(f.name) + "</strong><br><span class=\\"muted\\">" + (f.size / 1048576).toFixed(1) + " MB · tap to choose another</span>"; msg.className = "msg"; }
  pick.addEventListener("change", function () { choose(pick.files[0]); });
  ["dragenter", "dragover"].forEach(function (n) { drop.addEventListener(n, function (ev) { ev.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (n) { drop.addEventListener(n, function (ev) { ev.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (ev) { choose(ev.dataTransfer && ev.dataTransfer.files[0]); });
  btn.addEventListener("click", function () {
    if (!file) return;
    btn.disabled = true; bar.style.display = "block"; fill.style.width = "0";
    var xhr = new XMLHttpRequest();
    xhr.open("POST", location.pathname);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) fill.style.width = Math.round(100 * ev.loaded / ev.total) + "%"; };
    xhr.onload = function () {
      var r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 200 && r.ok) {
        fill.style.width = "100%";
        say("ok", "Filed as version " + esc(r.versionNumber) + ". <a href=\\"" + esc(r.hubUrl) + "\\">Open it in the Hub</a><br><span class=\\"muted\\">Go back to claude.ai and tell Claude the file is uploaded.</span>");
        drop.style.display = "none"; btn.style.display = "none";
      } else { bar.style.display = "none"; btn.disabled = false; say("err", esc(r.error || ("The upload did not work (" + xhr.status + "). Try again."))); }
    };
    xhr.onerror = function () { bar.style.display = "none"; btn.disabled = false; say("err", "The connection dropped before the file arrived. Try again."); };
    xhr.send(file);
  });
})();
</script>`);
}
