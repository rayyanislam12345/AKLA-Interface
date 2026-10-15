// Smoke test for the one-change-record routes against a running chat-service.
//
//   PW=... EMAIL=... node scripts/smoke-changes.mjs [--base https://aklachat.duckdns.org]
//
// Signs in as that user, opens the newest project .docx in a new Edit chat,
// asks for a small change, then lists, decides and downloads through
// /changes/list, /changes/decide and /documents/file. One line per check.
// Prints no tokens, keys or passwords. Exits 1 on any FAIL.
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = process.env.EMAIL;
const PW = process.env.PW;
const baseArg = process.argv.indexOf("--base");
const BASE = (baseArg > -1 ? process.argv[baseArg + 1] : "https://aklachat.duckdns.org").replace(/\/$/, "");
const MESSAGE = "Change the first paragraph's wording slightly and add one short sentence after it";

let failed = false;
const pass = (what) => console.log(`PASS ${what}`);
const fail = (what, reason) => { failed = true; console.log(`FAIL ${what}: ${reason}`); };
const check = (ok, what, reason) => (ok ? pass(what) : fail(what, reason));
const stop = (what, reason) => { fail(what, reason); process.exit(1); };

function readEnv() {
  const file = [".env.local", ".env"].find((f) => existsSync(f));
  if (!file) stop("read env", "no .env.local or .env in the current directory");
  const vars = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!vars.VITE_SUPABASE_URL || !vars.VITE_SUPABASE_PUBLISHABLE_KEY) stop("read env", `${file} lacks VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY`);
  return vars;
}

if (!EMAIL || !PW) stop("credentials", "set EMAIL and PW in the environment");
const env = readEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

const { data: auth, error: authError } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PW });
if (authError || !auth?.session) stop("sign in", authError?.message ?? "no session");
pass(`signed in as ${EMAIL}`);
const headers = { Authorization: `Bearer ${auth.session.access_token}`, apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };

// Newest .docx version on any project the user can see.
const { data: versions, error: versionError } = await supabase
  .from("document_versions")
  .select("id, file_name, created_at, matter_document:matter_documents!inner(id, title, matter_id)")
  .ilike("file_name", "%.docx")
  .order("created_at", { ascending: false })
  .limit(1);
const version = versions?.[0];
if (versionError || !version) stop("find a .docx version", versionError?.message ?? "none found");
const matterId = version.matter_document.matter_id;
pass(`picked ${version.matter_document.title} (${version.file_name}) on matter ${matterId}`);

// Every call gives up after a minute unless told otherwise, so a hung
// service fails the script instead of hanging it.
async function post(path, body, extra = {}) {
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000), ...extra });
}
async function readError(resp) {
  try { return (await resp.json()).error ?? `status ${resp.status}`; } catch { return `status ${resp.status}`; }
}

// One Edit turn in a new chat, through the same contract the app uses.
const chatBody = {
  matterId,
  documentTypeId: null,
  laws: null,
  threadId: null,
  message: MESSAGE,
  attachments: [],
  skill: { key: "edit", documentVersionId: version.id, matterDocumentId: version.matter_document.id },
  workingArtifactId: null,
};
const chat = await post("/chat", chatBody, { signal: AbortSignal.timeout(15 * 60 * 1000) });
if (!chat.ok || !chat.body) stop("POST /chat", await readError(chat));

let threadId = null;
let docxArtifact = null;
let doneEvent = null;
let streamError = null;
let replyChars = 0;
const handle = (event, data) => {
  if (event === "meta") threadId = data.threadId ?? threadId;
  else if (event === "delta") replyChars += (data.text ?? "").length;
  else if (event === "artifact" && data?.kind === "docx") docxArtifact = data;
  else if (event === "done") doneEvent = data;
  else if (event === "error") streamError = data.message ?? "unknown error";
};
const reader = chat.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    let event = "message";
    let dataLine = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (dataLine) handle(event, JSON.parse(dataLine));
  }
}
check(!!threadId, "chat stream sent meta with a threadId", "no meta event");
check(!streamError, "chat stream finished without an error event", streamError ?? "");
check(!!doneEvent, `chat stream sent done (${replyChars} reply characters)`, "no done event");
if (!docxArtifact) stop("chat stream sent a docx artifact", "none received");
pass(`docx artifact ${docxArtifact.id} with workingDocumentId ${docxArtifact.data?.workingDocumentId ?? "(missing)"}`);
check(!!docxArtifact.message_id, "artifact row carries message_id", "message_id is null on the streamed artifact");

// List.
const listResp = await post("/changes/list", { artifactId: docxArtifact.id });
if (!listResp.ok) stop("POST /changes/list", await readError(listResp));
const list = await listResp.json();
check(typeof list.workingDocumentId === "string" && list.workingDocumentId.length > 0, "list returns workingDocumentId", JSON.stringify(list.workingDocumentId));
check(list.workingDocumentId === docxArtifact.data?.workingDocumentId, "list workingDocumentId matches the artifact's", `${list.workingDocumentId} vs ${docxArtifact.data?.workingDocumentId}`);
check(!!list.head?.storagePath, "list returns a head with a storagePath", JSON.stringify(list.head));
const waiting = (list.changes ?? []).filter((c) => c.state === "waiting");
check(waiting.length >= 1, `list has at least one waiting card (${waiting.length} waiting of ${list.changes?.length ?? 0})`, "no card in state waiting");
check(waiting.every((c) => c.canAccept && c.canReject), "waiting cards can be accepted and rejected", "a waiting card has canAccept/canReject false");
check(list.counts?.waiting === waiting.length, "counts.waiting matches the cards", `${list.counts?.waiting} vs ${waiting.length}`);
check(typeof list.counts?.unlisted === "number", `counts carry unlisted (${list.counts?.unlisted})`, "counts.unlisted missing");
check(list.counts?.unlisted === 0, "every AI change in the file is in the list", `${list.counts?.unlisted} unlisted`);
if (waiting.length === 0) process.exit(1);

// Decide: accept the first waiting card, reject the second if there is one.
const decisions = [{ changeId: waiting[0].id, decision: "accepted" }];
if (waiting[1]) decisions.push({ changeId: waiting[1].id, decision: "rejected" });
const decideResp = await post("/changes/decide", { artifactId: docxArtifact.id, decisions });
if (!decideResp.ok) stop("POST /changes/decide", await readError(decideResp));
const decided = await decideResp.json();
// decide returns the head as its artifact row (data.storagePath,
// data.changeCounts); list returns the head summary (storagePath at the top).
check(decided.head?.data?.storagePath && decided.head.data.storagePath !== list.head.storagePath, "decide returns a head row with a new data.storagePath", `before ${list.head.storagePath}, after ${decided.head?.data?.storagePath}`);
check(decided.head?.data?.workingDocumentId === list.workingDocumentId, "decide head row carries workingDocumentId", `${decided.head?.data?.workingDocumentId}`);
check(decided.head?.data?.changeCounts?.waiting === decided.counts?.waiting, "decide head row's changeCounts match counts", `${decided.head?.data?.changeCounts?.waiting} vs ${decided.counts?.waiting}`);
check((decided.notDone ?? []).length === 0, "decide did everything it was asked", JSON.stringify(decided.notDone ?? []));
const byId = new Map((decided.changes ?? []).map((c) => [c.id, c]));
check(byId.get(waiting[0].id)?.state === "accepted", "first card now reads accepted", `state ${byId.get(waiting[0].id)?.state}`);
if (waiting[1]) check(byId.get(waiting[1].id)?.state === "rejected", "second card now reads rejected", `state ${byId.get(waiting[1].id)?.state}`);
check(byId.get(waiting[0].id)?.decided?.at, "accepted card carries who decided and when", "decided is null");
const stillWaiting = decided.counts?.waiting ?? 0;
pass(`counts after deciding: ${stillWaiting} waiting, ${decided.counts?.accepted ?? 0} accepted, ${decided.counts?.rejected ?? 0} rejected`);

// Download, tracked and clean.
const tracked = await post("/documents/file", { artifactId: decided.head.id, form: "tracked" });
// The body is only read for the error text when it is one: reading a 200
// body here would leave nothing for the bytes below.
check(tracked.status === 200, "tracked download returns 200", tracked.ok ? "" : await readError(tracked));
const trackedWaiting = tracked.headers.get("x-changes-waiting");
check(trackedWaiting !== null, `tracked download sends X-Changes-Waiting (${trackedWaiting})`, "header missing");
check(Number(trackedWaiting) === stillWaiting, "X-Changes-Waiting equals counts.waiting", `${trackedWaiting} vs ${stillWaiting}`);
const trackedBytes = tracked.ok ? (await tracked.arrayBuffer()).byteLength : 0;
check(trackedBytes > 0, `tracked download has bytes (${trackedBytes})`, "empty body");

const clean = await post("/documents/file", { artifactId: decided.head.id, form: "clean" });
if (stillWaiting > 0) {
  const cleanBody = clean.status === 409 ? await clean.json().catch(() => ({})) : {};
  check(clean.status === 409, `clean download returns 409 while ${stillWaiting} waiting`, `status ${clean.status}`);
  check(/^Decide the \d+ changes? waiting for you first\.$/.test(cleanBody.error ?? ""), "clean refusal uses the plain sentence", JSON.stringify(cleanBody.error ?? null));
} else {
  check(clean.status === 200, "clean download returns 200 with nothing waiting", clean.ok ? "" : await readError(clean));
}

console.log(`Thread ${threadId} on matter ${matterId}; working document ${list.workingDocumentId}; head ${decided.head.id}`);
process.exit(failed ? 1 : 0);
