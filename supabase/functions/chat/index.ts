import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { extractTextFromFile } from "../_shared/extractText.ts";

// The AI Workspace's single conversational endpoint — the thing the
// claude.ai-style chat talks to. One streaming request per turn: it owns the
// thread and messages, reads attachments, grounds the reply in the firm's
// library (this matter's documents, the precedent library, the law library
// scoped to the matter's Relevant Laws — the same three searches rag-query
// runs), applies the skill in force, streams the model's reply as
// server-sent events, and turns any document the model produced into an
// artifact row the right-hand panel can open.
//
// Skills:
//   draft     — interview-then-draft a document of a given type, grounded in
//               the firm's standard template and typed precedent (mirrors
//               drafting-interview + draft-document); the draft is an artifact.
//   verify    — run suggest-redline's three passes on an attached matter
//               document and hand back a review artifact.
//   summarise — a "Notes On …" memo in the firm's house style, as an artifact.
//   custom    — a row from ai_skills: extra instructions, optionally producing
//               a memo artifact.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CHAT_MODEL = "claude-sonnet-5";
const TITLE_MODEL = "claude-haiku-4-5-20251001";
const MAX_HISTORY = 30;
const MAX_ATTACHMENT_CHARS = 60_000;
const MAX_ATTACHMENTS_TOTAL_CHARS = 160_000;
// A full agreement runs long — longer than one invocation of this function
// gets to live. Supabase kills the isolate at about 150s of wall clock, with
// no chance to run any cleanup: measured directly, a draft turn streamed
// ~24k characters and was then cut off mid-sentence with no "done" event and
// nothing written to the database at all.
//
// So generation stops itself at a deadline comfortably inside that, saves
// what it has, and tells the client the turn is unfinished. The client
// immediately asks again with continueMessageId, which starts a fresh
// invocation (and a fresh wall clock) that resumes from exactly where the
// text left off. A document of any length therefore completes across as many
// invocations as it needs, and nothing is ever lost to the timeout.
const MAX_TOKENS = 32_000;
const GENERATION_BUDGET_MS = 115_000;
// Below this there isn't enough left to say anything useful, so stop and let
// the next invocation do it.
const MIN_USEFUL_SLICE_MS = 8_000;
// Continuing inside one invocation is still worth doing when the model hits
// max_tokens early and there is wall clock to spare.
const MAX_CONTINUATIONS = 3;
const MATCH_THRESHOLD = 0.35;
// A retrieved chunk is normally a few thousand characters, but a handful of
// legacy rows hold a whole document (the largest is 11MB) — one of those in
// the prompt is an instant "prompt too long". Cap what each source contributes.
const MAX_SOURCE_CHARS = 8_000;

interface Attachment {
  bucket: string;
  path: string;
  name: string;
  size?: number;
  type?: string;
  matterDocumentId?: string;
  versionId?: string;
  text?: string;
  chars?: number;
}

interface Skill {
  key: "draft" | "verify" | "summarise" | "edit" | "custom";
  documentTypeId?: string;
  customSkillId?: string;
  // edit: the exact version being worked on
  documentVersionId?: string;
  matterDocumentId?: string;
}

interface ProjectVersion {
  id: string;
  version_number: number;
  file_name: string;
  storage_path: string;
}
interface ProjectDocument {
  id: string;
  title: string;
  document_type_id: string | null;
  document_type: { name: string } | null;
  versions: ProjectVersion[];
}

// The whole of the document being edited goes into the prompt; this is the
// ceiling before the tail is dropped, well above any agreement the firm has.
const MAX_EDIT_CHARS = 150_000;
// How many project documents a single message may pull in by name.
const MAX_REFERENCED_DOCS = 3;

type Scope = "matter" | "precedent" | "statute";
interface Match {
  id: string;
  content: string;
  metadata: any;
  matter_id: string | null;
  document_type_id: string | null;
  similarity: number;
}

// The drafting conventions lib/firmDocx.ts relies on to export a document
// with the firm's own clause numbering — identical to draft-document's.
const FIRM_MARKDOWN_RULES = `Format the document as Markdown matching the firm's clause-numbering convention exactly:
- Exactly one "# " heading, for the document title only (e.g. "# CONCESSION AGREEMENT").
- "## " for each top-level clause/section — heading text only. Do NOT type the clause number yourself; numbering is generated on export, so a typed "1. " would duplicate it.
- "### " for a sub-clause, "#### " one level deeper if genuinely needed — same rule, no typed numbers.
- Ordinary paragraphs for recitals and body text that isn't itself a numbered sub-item.
- A Markdown list ("- " per item) for enumerated sub-items within a clause — don't type the letter/number yourself.
- A blank line between clauses and before/after the execution block.`;

const COMPLETENESS_RULES = `The document must be COMPLETE and ready to edit — this is the single most important requirement:
- Write every clause in full, from the title through to the execution block. Never stop part-way.
- Never abbreviate or gesture at content you haven't written: no "[remaining clauses follow the standard form]", no "…", no "(clauses 12-20 omitted)", no "Schedule 1 to be inserted", no "the rest continues as usual". If a clause belongs in the document, write it out.
- Never ask whether to continue, never offer to write the rest on request, and never end a turn mid-document to check in. Produce the whole thing.
- Length is not a reason to stop. A long agreement is expected to be long; keep writing until the document is genuinely finished.
- If you genuinely cannot complete it in one turn, finish the clause you are on and say plainly where you stopped — do not pretend the document is done.`;

const ARTIFACT_RULES = `When you produce a complete document (a draft, a memo, a note), wrap ONLY the document itself in an artifact block so it opens in its own panel:
<artifact kind="draft|memo" title="Short document title">
…the document in Markdown…
</artifact>
Everything outside the block is your normal reply to the lawyer (keep that short — a sentence or two about what you did or need). Never put commentary inside the block. If you revise a document already produced in this conversation, output the FULL revised document in a new artifact block with the same title.`;

// How a half-written reply is picked up again. The obvious mechanism —
// prefilling the assistant turn and letting the model run straight on from it —
// is not available: this model rejects it outright ("This model does not
// support assistant message prefill. The conversation must end with a user
// message"). So the partial goes in as a normal assistant turn and this follows
// it as the user turn, a shape the API does accept. The wording has to be
// blunt, because the model's instinct is to greet, recap, or start over.
function continueInstruction(partial: string): string {
  return [
    "CONTINUE — you were cut off part-way through the reply above. Carry straight on from exactly where it stops.",
    "",
    "- Your very next character continues that text. Do NOT repeat any of it, do NOT summarise it, do NOT start again.",
    "- Start with whatever character makes the join seamless — including a newline if the text stops at the end of a line or paragraph.",
    '- No preamble. Never write "continuing", "here is the rest", or anything of that kind.',
    "- Keep the same formatting, numbering and drafting conventions you were already using.",
    "- If you opened an <artifact> block that is still open, keep writing inside it and close it with </artifact> once the document is genuinely finished.",
    "",
    "For precision, the text you are continuing ends with:",
    partial.slice(-300),
  ].join("\n");
}

// Words that carry no identity on their own. "agreement" is deliberately NOT
// here: alone it identifies nothing, but paired — "services agreement",
// "concession agreement" — it is exactly how lawyers name a file, and the
// two-word threshold below is what stops it matching on its own.
const REFERENCE_STOPWORDS = new Set([
  "the", "of", "and", "for", "to", "a", "an", "on", "in", "with", "by", "re", "draft", "final", "clean",
  "version", "doc", "copy", "execution", "signed", "revised", "updated", "latest", "current",
]);

function normaliseWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

// Which of the project's documents a message is talking about. Associates
// refer to files the way they speak — "the concession agreement", "v2 of the
// shareholders agreement", "the EPA" — and the vector search cannot be relied
// on to surface the right file, let alone the whole of it. So a mention is
// resolved here and the version's full text is attached for the turn, exactly
// as if the lawyer had dragged the file in.
//
// Matching, most to least certain: the whole title or filename stem appears
// in the message; enough of the title's distinctive words do; or the message
// names a document type of which the project has exactly one. "v2" /
// "version 2" in the message picks that version, otherwise the latest.
function resolveReferences(message: string, docs: ProjectDocument[], excludeDocId?: string): Array<{ doc: ProjectDocument; version: ProjectVersion }> {
  const msgWords = normaliseWords(message);
  const msgSet = new Set(msgWords);
  const msgNorm = ` ${msgWords.join(" ")} `;
  const versionAsk = /\b(?:v|version\s*)(\d{1,3})\b/i.exec(message);
  const pickVersion = (doc: ProjectDocument) => {
    const sorted = [...doc.versions].sort((a, b) => b.version_number - a.version_number);
    if (versionAsk) {
      const want = sorted.find((v) => v.version_number === Number(versionAsk[1]));
      if (want) return want;
    }
    return sorted[0];
  };

  // Scored, not boolean: an exact title or filename is certain; otherwise it
  // takes at least two of the title's distinctive words (one if the title has
  // only one). Titles here run long — "Services Agreement — M6 Motorway
  // Independent Engineering Review (Execution Version)" — so demanding most
  // of the title's words would miss the way anyone actually refers to it.
  // Where several documents match, the strongest matches win the slots.
  const scored: Array<{ doc: ProjectDocument; version: ProjectVersion; score: number }> = [];
  for (const doc of docs) {
    if (!doc.versions?.length || doc.id === excludeDocId) continue;
    const titleNorm = normaliseWords(doc.title).join(" ");
    const stem = normaliseWords((doc.versions[0].file_name ?? "").replace(/\.[a-z0-9]+$/i, "")).join(" ");
    if ((titleNorm.length >= 4 && msgNorm.includes(` ${titleNorm} `)) || (stem.length >= 10 && msgNorm.includes(` ${stem} `))) {
      scored.push({ doc, version: pickVersion(doc), score: 1000 });
      continue;
    }
    const distinctive = [...new Set(normaliseWords(doc.title).filter((w) => w.length >= 3 && !REFERENCE_STOPWORDS.has(w)))];
    if (!distinctive.length) continue;
    const matched = distinctive.filter((w) => msgSet.has(w)).length;
    if (matched >= Math.min(2, distinctive.length)) scored.push({ doc, version: pickVersion(doc), score: matched });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits: Array<{ doc: ProjectDocument; version: ProjectVersion }> = scored.map(({ doc, version }) => ({ doc, version }));

  if (!hits.length) {
    const byType = new Map<string, ProjectDocument[]>();
    for (const doc of docs) {
      const t = doc.document_type?.name;
      if (t && doc.versions?.length && doc.id !== excludeDocId) byType.set(t, [...(byType.get(t) ?? []), doc]);
    }
    for (const [typeName, list] of byType) {
      if (list.length === 1 && msgNorm.includes(` ${normaliseWords(typeName).join(" ")} `)) {
        hits.push({ doc: list[0], version: pickVersion(list[0]) });
      }
    }
  }
  return hits.slice(0, MAX_REFERENCED_DOCS);
}

function sse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function deriveTitle(message: string, skill: Skill | null, documentTypeName: string | null): string {
  if (skill?.key === "draft" && documentTypeName) return `Draft: ${documentTypeName}`;
  if (skill?.key === "verify") return "Review";
  if (skill?.key === "summarise") return "Summary";
  if (skill?.key === "edit") return "Edit";
  const firstLine = message.trim().split("\n")[0].replace(/\s+/g, " ");
  return firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + "…" : firstLine || "New chat";
}

async function anthropicJson(apiKey: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

// Streams one Anthropic messages call, invoking onDelta for each text delta.
// Resolves with the text *and* why generation stopped — "max_tokens" means the
// response was cut off mid-sentence, which the caller has to handle rather
// than pass off as a finished answer.
async function anthropicStreamOnce(
  apiKey: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; stopReason: string | null; aborted: boolean }> {
  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === "AbortError") return { text: "", stopReason: null, aborted: true };
    throw err;
  }
  if (!resp.ok || !resp.body) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let stopReason: string | null = null;
  // Running out of time is a normal outcome here, not a failure: the text
  // generated so far is kept and handed back for the next invocation.
  let aborted = false;
  while (true) {
    let value: Uint8Array | undefined;
    try {
      const chunk = await reader.read();
      if (chunk.done) break;
      value = chunk.value;
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
        aborted = true;
        break;
      }
      throw err;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
          full += payload.delta.text;
          onDelta(payload.delta.text);
        } else if (payload.type === "message_delta" && payload.delta?.stop_reason) {
          stopReason = payload.delta.stop_reason;
        } else if (payload.type === "error") {
          throw new Error(payload.error?.message ?? "stream error");
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  return { text: full, stopReason, aborted };
}

// Generates until the answer is genuinely finished, the wall-clock budget runs
// out, or the model stops producing. Text already written is never discarded:
// whatever exists is handed back with `incomplete` saying whether more is owed.
//
// `initialText` is what a previous invocation already wrote. It is replayed as
// an assistant turn followed by a continue instruction (see continueInstruction
// — prefill is not available on this model), which is what lets one document
// span as many invocations as it takes.
async function anthropicComplete(
  apiKey: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  opts: { initialText?: string; deadlineAt: number; maxContinuations?: number; clientSignal?: AbortSignal },
): Promise<{ text: string; generated: string; incomplete: boolean; stoppedByClient: boolean }> {
  const { initialText = "", deadlineAt, maxContinuations = MAX_CONTINUATIONS, clientSignal } = opts;
  const baseMessages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  let accumulated = initialText;
  let generated = "";
  let incomplete = false;
  let stoppedByClient = false;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= MIN_USEFUL_SLICE_MS) {
      incomplete = true;
      break;
    }
    // Deliberately NOT trimmed: the partial is replayed verbatim so a trailing
    // newline survives. Stripping it would leave the model guessing whether the
    // text stopped mid-line or at a line end, and it guesses wrong — a dropped
    // newline welds the next clause onto the end of the previous one.
    //
    // The conversation has to end on a user turn, so the partial becomes the
    // assistant turn and the instruction to carry on becomes the user turn.
    const messages = accumulated
      ? [
          ...baseMessages,
          { role: "assistant", content: accumulated },
          { role: "user", content: continueInstruction(accumulated) },
        ]
      : baseMessages;

    // One signal for two reasons to stop: the wall-clock budget, and the
    // lawyer pressing Stop (the browser closes the connection, req.signal
    // fires). Without the second, Stop only stopped the *display* — the model
    // kept writing to the end and the whole turn was billed anyway.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), remaining);
    const onClientGone = () => stop.abort();
    clientSignal?.addEventListener("abort", onClientGone, { once: true });
    let result;
    try {
      result = await anthropicStreamOnce(apiKey, { ...body, messages }, onDelta, stop.signal);
    } finally {
      clearTimeout(timer);
      clientSignal?.removeEventListener("abort", onClientGone);
    }
    accumulated += result.text;
    generated += result.text;

    if (clientSignal?.aborted) {
      stoppedByClient = true;
      break;
    }
    if (result.aborted) {
      incomplete = true;
      break;
    }
    if (result.stopReason !== "max_tokens") break;
    if (!result.text) break;  // nothing came back — continuing would just spin
    if (attempt === maxContinuations) incomplete = true;
  }

  return { text: accumulated, generated, incomplete, stoppedByClient };
}

// Turns raw model output into a stored reply: every <artifact> block becomes
// an ai_artifacts row and is replaced in the text by an [[artifact:id]]
// marker. Used for a finished turn, and to tidy up a partial reply that was
// never resumed — in both cases an unterminated block is closed rather than
// lost, so a half-written draft is still a draft the lawyer can open.
async function persistReply(supabase: any, p: {
  threadId: string;
  matterId: string;
  userId: string;
  text: string;
  messageId: string | null;
  metadata: Record<string, unknown>;
  artifactData: Record<string, unknown>;
  defaultTitle: string;
  send?: (event: string, data: unknown) => void;
}): Promise<{ assistantMessageId: string | null; content: string }> {
  const opened = (p.text.match(/<artifact\s/g) ?? []).length;
  const closed = (p.text.match(/<\/artifact>/g) ?? []).length;
  const truncated = opened > closed;
  const modelText = truncated ? `${p.text}\n</artifact>` : p.text;

  const artifactIds: string[] = [];
  let content = modelText;
  const re = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
  let match: RegExpExecArray | null;
  const replacements: Array<[string, string]> = [];
  while ((match = re.exec(modelText)) !== null) {
    const attrs = match[1];
    const kind = /kind="([^"]+)"/.exec(attrs)?.[1] === "draft" ? "draft" : "memo";
    const title = /title="([^"]+)"/.exec(attrs)?.[1] ?? (kind === "draft" ? p.defaultTitle : "Memo");
    const { data: artifact } = await supabase
      .from("ai_artifacts")
      .insert({
        thread_id: p.threadId,
        matter_id: p.matterId,
        kind,
        title,
        content: match[2].trim(),
        data: { ...p.artifactData, ...(truncated ? { truncated: true } : {}) },
        created_by: p.userId,
      })
      .select("*")
      .single();
    if (artifact) {
      artifactIds.push(artifact.id);
      replacements.push([match[0], `[[artifact:${artifact.id}]]`]);
      p.send?.("artifact", artifact);
    }
  }
  for (const [from, to] of replacements) content = content.replace(from, to);
  content = content.trim();

  // `incomplete` must not survive — it is what the client loops on.
  const { incomplete: _wasIncomplete, ...rest } = p.metadata;
  const metadata = { ...rest, artifacts: artifactIds };
  let assistantMessageId = p.messageId;
  if (assistantMessageId) {
    await supabase.from("ai_chat_messages").update({ content, metadata }).eq("id", assistantMessageId);
  } else {
    const { data } = await supabase
      .from("ai_chat_messages")
      .insert({ thread_id: p.threadId, role: "assistant", content, metadata })
      .select("id")
      .single();
    assistantMessageId = data?.id ?? null;
  }
  if (assistantMessageId && artifactIds.length) {
    await supabase.from("ai_artifacts").update({ message_id: assistantMessageId }).in("id", artifactIds);
  }
  return { assistantMessageId, content };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startedAt = Date.now();
  const encoder = new TextEncoder();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const {
    matterId,
    threadId: requestedThreadId = null,
    message = "",
    attachments: rawAttachments = [],
    skill = null,
    // Set when picking up a reply a previous invocation ran out of time to
    // finish. Not a new turn: no user message is recorded, and the partial
    // reply already stored under this id is what generation resumes from.
    continueMessageId = null,
  } = body as {
    matterId: string; threadId?: string | null; message: string;
    attachments?: Attachment[]; skill?: Skill | null; continueMessageId?: string | null;
  };
  const isContinuation = !!continueMessageId;

  if (!matterId) return json(400, { error: "matterId is required" });
  if (isContinuation && !requestedThreadId) return json(400, { error: "threadId is required to continue a reply" });
  if (!isContinuation && !message.trim() && rawAttachments.length === 0) {
    return json(400, { error: "Say something or attach a document" });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Authorization header required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const voyageKey = Deno.env.get("VOYAGE_API_KEY");
  if (!anthropicKey) return json(500, { error: "Anthropic API key not configured" });
  if (!voyageKey) return json(500, { error: "Voyage API key not configured" });

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (userError || !user) return json(401, { error: "Unauthorized" });

  // ---- everything the prompt needs about the matter, in parallel ----
  const [{ data: matter }, { data: parties }, { data: matterContext }, { data: relevantLaws }, documentTypeResult, customSkillResult, projectDocsResult] =
    await Promise.all([
      supabase.from("matters").select("id, name, sector, description, client:clients(name)").eq("id", matterId).single(),
      supabase.from("matter_parties").select("name, role").eq("matter_id", matterId),
      supabase.from("matter_context").select("content").eq("matter_id", matterId).maybeSingle(),
      supabase.from("matter_relevant_laws").select("act_name").eq("matter_id", matterId).eq("status", "available"),
      skill?.documentTypeId
        ? supabase.from("document_types").select("id, name, category, required_fields").eq("id", skill.documentTypeId).single()
        : Promise.resolve({ data: null }),
      skill?.key === "custom" && skill.customSkillId
        ? supabase.from("ai_skills").select("name, instructions, produces_document").eq("id", skill.customSkillId).single()
        : Promise.resolve({ data: null }),
      supabase
        .from("matter_documents")
        .select("id, title, document_type_id, document_type:document_types(name), versions:document_versions(id, version_number, file_name, storage_path)")
        .eq("matter_id", matterId),
    ]);
  if (!matter) return json(404, { error: "Project not found" });
  const projectDocs = ((projectDocsResult as any).data ?? []) as ProjectDocument[];
  const documentType = documentTypeResult.data as { id: string; name: string; category: string; required_fields: unknown } | null;
  const customSkill = customSkillResult.data as { name: string; instructions: string; produces_document: boolean } | null;

  // ---- thread + the lawyer's message, before any streaming so a failure is visible ----
  let thread: { id: string; title: string | null; skill: Skill | null } | null = null;
  if (requestedThreadId) {
    const { data } = await supabase.from("ai_chat_threads").select("id, title, skill").eq("id", requestedThreadId).single();
    thread = data as typeof thread;
  }
  const isNewThread = !thread;
  if (!thread) {
    const { data, error } = await supabase
      .from("ai_chat_threads")
      .insert({
        matter_id: matterId,
        title: deriveTitle(message, skill, documentType?.name ?? null),
        created_by: user.id,
        skill: skill ?? null,
      })
      .select("id, title, skill")
      .single();
    if (error || !data) return json(500, { error: `Could not create the conversation: ${error?.message}` });
    thread = data as typeof thread;
  } else if (skill && !thread.skill) {
    await supabase.from("ai_chat_threads").update({ skill }).eq("id", thread.id);
  }
  const threadId = thread!.id;

  let resumeMessage: { id: string; content: string } | null = null;
  if (isContinuation) {
    const { data } = await supabase
      .from("ai_chat_messages")
      .select("id, content")
      .eq("id", continueMessageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (!data) return json(404, { error: "The reply to continue no longer exists" });
    resumeMessage = data as { id: string; content: string };
  }

  const { data: history } = await supabase
    .from("ai_chat_messages")
    .select("id, role, content, metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);
  // The partial reply is the prefill, not a prior turn — it must not appear
  // twice in the conversation handed to the model.
  const priorMessages = (history ?? []).reverse().filter((m: any) => m.id !== continueMessageId);

  // ---- edit: the document being worked on ----
  // The base is the newest draft artifact in this thread — the version as
  // uploaded on the first turn, the latest AI edit on every turn after — so
  // a conversation refines one document iteratively. A thread with no
  // artifact yet (opened by URL, say) reads the version from storage.
  let editBase: { content: string; editSource: Record<string, unknown>; original: boolean; documentTypeId?: string } | null = null;
  if (skill?.key === "edit") {
    const { data: latest } = await supabase
      .from("ai_artifacts")
      .select("content, data")
      .eq("thread_id", threadId)
      .eq("kind", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const d = (latest?.data ?? {}) as any;
    if (latest?.content && d.editSource) {
      editBase = { content: latest.content, editSource: d.editSource, original: !!d.original, documentTypeId: d.documentTypeId };
    } else if (skill.documentVersionId) {
      const { data: v } = await supabase
        .from("document_versions")
        .select("id, version_number, file_name, storage_path, matter_document:matter_documents(id, title, document_type_id)")
        .eq("id", skill.documentVersionId)
        .maybeSingle();
      if (v) {
        const { data: blob } = await supabase.storage.from("matter-documents").download(v.storage_path);
        if (blob) {
          const { text } = await extractTextFromFile(blob, v.file_name);
          const md = (v as any).matter_document;
          editBase = {
            content: text,
            original: true,
            documentTypeId: md?.document_type_id ?? undefined,
            editSource: {
              matterDocumentId: md?.id ?? skill.matterDocumentId,
              documentVersionId: v.id,
              versionNumber: v.version_number,
              title: md?.title ?? v.file_name,
              fileName: v.file_name,
            },
          };
        }
      }
    }
    if (!editBase) return json(400, { error: "Pick a document version to edit first (+ → Edit a document)." });
  }

  const attachments: Attachment[] = (rawAttachments as Attachment[]).map((a) => ({
    bucket: a.bucket,
    path: a.path,
    name: a.name,
    size: a.size,
    type: a.type,
    matterDocumentId: a.matterDocumentId,
    versionId: a.versionId,
  }));

  // Documents the message names are attached for this turn — stored on the
  // message too, so they show as chips and stay in context afterwards.
  const referenced = isContinuation ? [] : resolveReferences(message, projectDocs, skill?.key === "edit" ? skill.matterDocumentId : undefined);
  for (const { doc, version } of referenced) {
    if (attachments.some((a) => a.versionId === version.id || a.path === version.storage_path)) continue;
    attachments.push({
      bucket: "matter-documents",
      path: version.storage_path,
      name: `${doc.title} (v${version.version_number}) — ${version.file_name}`,
      matterDocumentId: doc.id,
      versionId: version.id,
    });
  }

  let userMessageId: string | null = null;
  if (!isContinuation) {
    const { data: userMessage, error: userMsgError } = await supabase
      .from("ai_chat_messages")
      .insert({
        thread_id: threadId,
        role: "user",
        content: message,
        created_by: user.id,
        metadata: { attachments, skill: skill ?? null },
      })
      .select("id")
      .single();
    if (userMsgError || !userMessage) return json(500, { error: `Could not save the message: ${userMsgError?.message}` });
    userMessageId = userMessage.id;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => sse(controller, encoder, event, data);

      (async () => {
        try {
          send("meta", { threadId, userMessageId, title: thread!.title, continuing: isContinuation });
          for (const { doc, version } of referenced) {
            send("notice", { text: `Reading ${doc.title} (v${version.version_number}) from the project.` });
          }

          // ---- attachments: read them now, remember the text on the message so
          // the document stays in context for the rest of the conversation ----
          let totalChars = 0;
          for (const a of attachments) {
            try {
              const { data: blob, error } = await supabase.storage.from(a.bucket).download(a.path);
              if (error || !blob) throw new Error(error?.message ?? "download failed");
              const { text } = await extractTextFromFile(blob, a.name);
              const clipped = text.slice(0, MAX_ATTACHMENT_CHARS);
              a.text = clipped;
              a.chars = text.length;
              totalChars += clipped.length;
            } catch (err) {
              a.text = "";
              a.chars = 0;
              send("notice", { text: `Couldn't read "${a.name}": ${err instanceof Error ? err.message : String(err)}` });
            }
          }
          if (attachments.length > 0 && userMessageId) {
            await supabase.from("ai_chat_messages").update({ metadata: { attachments, skill: skill ?? null } }).eq("id", userMessageId);
          }

          // Documents attached earlier in this conversation stay in context —
          // the way a file you dropped into claude.ai three messages ago still
          // counts — deduplicated by path, newest first, within a budget.
          const contextDocs: Attachment[] = [];
          const seen = new Set<string>();
          const candidates: Attachment[] = [
            ...attachments,
            ...[...priorMessages].reverse().flatMap((m: any) => (m.role === "user" ? (m.metadata?.attachments ?? []) : [])),
          ];
          for (const a of candidates) {
            const key = `${a.bucket}/${a.path}`;
            if (seen.has(key) || !a.text) continue;
            if (totalChars > MAX_ATTACHMENTS_TOTAL_CHARS && !attachments.includes(a)) break;
            seen.add(key);
            contextDocs.push(a);
            totalChars += a.text.length;
          }

          // ---- verify: a review is the existing three-pass engine, not a chat reply ----
          if (skill?.key === "verify") {
            const target = attachments.find((a) => a.versionId) ?? contextDocs.find((a) => a.versionId);
            if (!target?.versionId) {
              throw new Error("Attach one of this project's documents (Add from project) to review it.");
            }
            const reviewResp = await fetch(`${supabaseUrl}/functions/v1/suggest-redline`, {
              method: "POST",
              headers: { Authorization: authHeader, apikey: serviceKey, "Content-Type": "application/json" },
              body: JSON.stringify({ documentVersionId: target.versionId }),
            });
            if (!reviewResp.ok) throw new Error(`Review failed: ${(await reviewResp.text()).slice(0, 200)}`);
            const review = await reviewResp.json();
            const suggestions: any[] = review.suggestions ?? [];
            const byType: Record<string, number> = {};
            for (const s of suggestions) byType[s.review_type] = (byType[s.review_type] ?? 0) + 1;

            const artifactData: Record<string, unknown> = {
              documentVersionId: target.versionId,
              matterDocumentId: target.matterDocumentId ?? null,
              suggestionCount: suggestions.length,
              byType,
            };

            // A typed instruction alongside the review (e.g. a Revise link's
            // "check this against the amendment") goes through redline-chat,
            // which can add targeted suggestions of its own.
            let instructionReply = "";
            if (message.trim()) {
              try {
                const rcResp = await fetch(`${supabaseUrl}/functions/v1/redline-chat`, {
                  method: "POST",
                  headers: { Authorization: authHeader, apikey: serviceKey, "Content-Type": "application/json" },
                  body: JSON.stringify({ documentVersionId: target.versionId, instruction: message }),
                });
                if (rcResp.ok) {
                  const rc = await rcResp.json();
                  instructionReply = String(rc.reply ?? "");
                  for (const s of rc.newSuggestions ?? []) {
                    suggestions.push(s);
                    byType[s.review_type] = (byType[s.review_type] ?? 0) + 1;
                  }
                  artifactData.suggestionCount = suggestions.length;
                }
              } catch (err) {
                send("notice", { text: `The review ran, but your instruction couldn't be applied: ${err instanceof Error ? err.message : String(err)}` });
              }
            }

            const summaryPrompt = `You are summarising an AI review of "${target.name}" for the lawyer who asked for it. The review ran three passes — legal clauses & citations, formatting, content & conflicts — and produced the suggestions below. Write 3–6 short lines in Markdown: how many issues per pass and the two or three that matter most, named by clause. Don't list everything; the full review is open beside this reply. No preamble.

SUGGESTIONS:
${JSON.stringify(suggestions.map((s) => ({ pass: s.review_type, clause: s.clause_reference, rationale: s.rationale })), null, 0).slice(0, 12_000)}`;
            const { data: artifact } = await supabase
              .from("ai_artifacts")
              .insert({ thread_id: threadId, matter_id: matterId, kind: "review", title: `Review: ${target.name}`, data: artifactData, created_by: user.id })
              .select("*")
              .single();
            if (!artifact) throw new Error("Could not record the review");

            let text = "";
            if (instructionReply) {
              text = instructionReply.trim() + "\n\n";
              send("delta", { text });
            }
            try {
              text += (await anthropicStreamOnce(anthropicKey, { model: CHAT_MODEL, max_tokens: 700, system: summaryPrompt, messages: [{ role: "user", content: "Summarise the review." }] }, (d) => send("delta", { text: d }))).text;
            } catch {
              const fallback = `Review complete: ${suggestions.length} suggestion(s).`;
              text += fallback;
              send("delta", { text: fallback });
            }
            const content = `${text.trim()}\n\n[[artifact:${artifact.id}]]`;
            const { data: assistantMsg } = await supabase
              .from("ai_chat_messages")
              .insert({ thread_id: threadId, role: "assistant", content, metadata: { artifacts: [artifact.id], skill } })
              .select("id")
              .single();
            await supabase.from("ai_artifacts").update({ message_id: assistantMsg?.id }).eq("id", artifact.id);
            send("artifact", artifact);
            send("done", { assistantMessageId: assistantMsg?.id, threadId, incomplete: false });
            controller.close();
            return;
          }

          // ---- retrieval: the same three searches rag-query runs ----
          // A continuation carries no new message, so the grounding is rebuilt
          // from the question that started the turn — same query, same corpus,
          // so the model resumes against the sources it began with.
          const lastUserMessage = [...priorMessages].reverse().find((m: any) => m.role === "user")?.content ?? "";
          const effectiveMessage = message || lastUserMessage;
          const retrievalQuery = [effectiveMessage, ...attachments.map((a) => a.name)].join("\n").slice(0, 8000) || documentType?.name || "";
          let sources: Array<Match & { scope: Scope }> = [];
          let templateHtml: string | null = null;
          let templateRules: string | null = null;
          if (retrievalQuery) {
            const embResp = await fetch("https://api.voyageai.com/v1/embeddings", {
              method: "POST",
              headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: "voyage-law-2", input: [retrievalQuery], input_type: "query" }),
            });
            if (embResp.ok) {
              const queryEmbedding = (await embResp.json()).data[0].embedding;
              const actNames = (relevantLaws ?? []).map((r: any) => r.act_name).filter(Boolean);
              const statuteParams: Record<string, unknown> = {
                query_embedding: queryEmbedding, match_threshold: MATCH_THRESHOLD, match_count: 4, statute_only: true,
              };
              // Omitted, not null: an empty act filter makes the SQL match nothing.
              if (actNames.length > 0) statuteParams.filter_act_names = actNames;
              const [m, p, s, t] = await Promise.all([
                supabase.rpc("match_documents", { query_embedding: queryEmbedding, match_threshold: MATCH_THRESHOLD, match_count: 6, filter_matter_id: matterId }),
                supabase.rpc("match_documents", {
                  query_embedding: queryEmbedding, match_threshold: MATCH_THRESHOLD, match_count: 6, precedent_only: true,
                  ...(documentType ? { filter_document_type_id: documentType.id } : {}),
                }),
                supabase.rpc("match_documents", statuteParams),
                documentType
                  ? supabase.from("document_type_templates").select("content_html, format_rules").eq("document_type_id", documentType.id).maybeSingle()
                  : Promise.resolve({ data: null }),
              ]);
              sources = [
                ...((m.data ?? []) as Match[]).map((x) => ({ ...x, scope: "matter" as const })),
                ...((p.data ?? []) as Match[]).map((x) => ({ ...x, scope: "precedent" as const })),
                ...((s.data ?? []) as Match[]).map((x) => ({ ...x, scope: "statute" as const })),
              ];
              templateHtml = (t as any)?.data?.content_html ?? null;
              templateRules = (t as any)?.data?.format_rules ?? null;
            }
          }
          const sourceSummaries = sources.map((d) => ({
            id: d.id, scope: d.scope, similarity: d.similarity,
            filename: d.metadata?.filename ?? null, act_name: d.metadata?.act_name ?? null,
            content: String(d.content ?? "").slice(0, 240),
          }));
          send("sources", sourceSummaries);

          // ---- the system prompt ----
          const clientName = (matter as any).client?.name;
          const partiesLine = (parties ?? []).length
            ? `\nParties on the project: ${(parties ?? []).map((p: any) => `${p.name} (${p.role})`).join("; ")}.`
            : "";
          const contextBlock = matterContext?.content?.trim()
            ? `\n\nCONTEXT CARRIED FORWARD ON THIS PROJECT (curated by the team):\n${matterContext.content.trim()}`
            : "";
          const docsListBlock = projectDocs.length
            ? `\n\nDOCUMENTS ON THIS PROJECT (only those attached above are readable to you — if the lawyer refers to one that isn't, name it and ask them to attach it rather than guess its contents):\n` +
              projectDocs.map((d) => {
                const vs = [...(d.versions ?? [])].sort((a, b) => a.version_number - b.version_number);
                const type = d.document_type?.name ? ` (${d.document_type.name})` : "";
                return `- ${d.title}${type}: ${vs.length ? vs.map((v) => `v${v.version_number} ${v.file_name}`).join(", ") : "no file uploaded yet"}`;
              }).join("\n")
            : "";
          const docsBlock = contextDocs.length
            ? `\n\nDOCUMENTS THE LAWYER HAS ATTACHED IN THIS CONVERSATION (read in full; treat as this project's own material):\n` +
              contextDocs.map((a) => `<document name="${a.name}"${a.chars && a.chars > (a.text?.length ?? 0) ? ` note="truncated to first ${a.text!.length} of ${a.chars} characters"` : ""}>\n${a.text}\n</document>`).join("\n\n")
            : "";
          const label = (d: Match & { scope: Scope }, i: number) => {
            if (d.scope === "statute") return `[Source ${i + 1}] (statute — ${d.metadata?.act_name ?? "unknown Act"})`;
            const fn = d.metadata?.filename ? ` — ${d.metadata.filename}` : "";
            return `[Source ${i + 1}] (${d.scope === "matter" ? "this project's document" : "precedent library"}${fn})`;
          };
          const sourcesBlock = sources.length
            ? `\n\nRETRIEVED FROM THE FIRM'S LIBRARY FOR THIS MESSAGE (cite by number when you rely on one):\n` +
              sources.map((d, i) => `${label(d, i)}\n${String(d.content ?? "").slice(0, MAX_SOURCE_CHARS)}`).join("\n\n---\n\n")
            : "\n\nNothing relevant was retrieved from the firm's library for this message.";

          let skillBlock = "";
          if (skill?.key === "draft" && documentType) {
            const reqFields = Array.isArray(documentType.required_fields) && (documentType.required_fields as unknown[]).length
              ? `\nThe firm flags these fields as required for this document type: ${JSON.stringify(documentType.required_fields)}.`
              : "";
            // The draft is exported inside the standard's own .docx, so its fonts,
            // page layout and Word numbering come for free; what the model owes is
            // the structure that maps onto that numbering.
            const rulesBlock = templateRules?.trim()
              ? `\n\nHOW THE STANDARD IS FORMATTED: ${templateRules.trim()}\nThe draft is exported inside that file, so its numbering, fonts and layout are applied automatically. Your Markdown maps onto it: "## " becomes a top-level clause, "### " a sub-clause, "#### " the level below, and "- " items the level below whichever heading they sit under. Match the standard's clause structure and the way it sets out definitions, recitals and the execution block.`
              : "";
            const templateBlock = templateHtml?.trim()
              ? `\n\nSTANDARD TEMPLATE FOR THIS DOCUMENT TYPE — the firm's canonical structure and formatting for a ${documentType.name}. Follow its clause structure as the primary basis; the precedent excerpts above are for phrasing and edge cases:\n${templateHtml}${rulesBlock}`
              : rulesBlock;
            skillBlock = `\n\nSKILL IN FORCE — DRAFT A "${documentType.name}" (${documentType.category}) FOR THIS PROJECT.${reqFields}${templateBlock}

How to work: you are conducting a short intake, then drafting. If the conversation does not yet give you the essentials — parties and roles, term, payment or tariff structure, performance security, governing law, dispute resolution, termination, and anything specific to this document type — ask ONE focused question at a time (short, concrete). Stop asking as soon as you have enough for a solid first version, or the moment the lawyer says to draft now / just draft. Then draft the COMPLETE document: proper drafting conventions (defined terms capitalised on first use, recitals, operative clauses, execution block), and a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] wherever a specific commercial term wasn't given rather than an invented figure. This is a first draft for a lawyer to edit, not a final.

${COMPLETENESS_RULES}

${FIRM_MARKDOWN_RULES}

${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="draft"')}`;
          } else if (skill?.key === "edit" && editBase) {
            const src = editBase.editSource as any;
            skillBlock = `\n\nSKILL IN FORCE — EDIT "${src.title}" (from v${src.versionNumber}${editBase.original ? ", the version as uploaded" : ", as last edited in this conversation"}).

CURRENT DOCUMENT — everything the lawyer asks for is applied to this text:
<document>
${editBase.content.slice(0, MAX_EDIT_CHARS)}
</document>

How to work: make exactly the changes asked for and leave everything else as it is — same clauses, same order, same defined terms, the same wording wherever you weren't asked to change it. When the lawyer points at another document or version (attached above), lift the clause, wording or formatting from that text and adapt its defined terms and cross-references to fit this document. If it is genuinely unclear where a change belongs, ask one short question rather than guess. Otherwise output the FULL revised document — never a diff, never "unchanged clauses omitted".

${COMPLETENESS_RULES}

${FIRM_MARKDOWN_RULES}
The current document may carry typed clause numbers in its headings; drop those (numbering is regenerated on export) but keep every heading's text and level exactly.

${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="draft"')} Title the artifact "${src.title}".`;
          } else if (skill?.key === "summarise") {
            skillBlock = `\n\nSKILL IN FORCE — "NOTES ON …" MEMO. Explain the attached (or discussed) document in plain English for a busy lawyer, as a short memo in the firm's house style: a "# Notes On <document>" title, then "## " sections — What it does; The points that matter (short numbered points via "- " list items, each one idea); What to watch. Tight and selective, not an exhaustive clause list. If nothing was attached and nothing was retrieved, say what you need. Finish the memo — never break off part-way or ask whether to carry on.

${FIRM_MARKDOWN_RULES}

${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="memo"')}`;
          } else if (skill?.key === "custom" && customSkill) {
            skillBlock = `\n\nSKILL IN FORCE — "${customSkill.name}" (the firm's own instructions):\n${customSkill.instructions}` +
              (customSkill.produces_document ? `\n\n${COMPLETENESS_RULES}\n\n${FIRM_MARKDOWN_RULES}\n\n${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="memo"')}` : "");
          } else {
            skillBlock = `\n\n${ARTIFACT_RULES}`;
          }

          const systemPrompt = `You are the AI assistant inside AKLA Project Hub, the internal system of Ali Khan Law Associates, a Pakistani corporate, projects and PPP law firm. You are working with a lawyer on the project "${matter.name}"${clientName ? ` (client: ${clientName})` : ""}${matter.sector ? `, sector: ${matter.sector}` : ""}.${matter.description ? `\nProject description: ${matter.description}` : ""}${partiesLine}${contextBlock}${docsListBlock}

You answer the way a careful senior associate would: precise, conservative, and honest about the limits of what the sources show. Ground every legal statement in the retrieved sources or the attached documents and cite them by number (e.g. [Source 2]); distinguish clearly between what THIS project's documents say, what the firm's precedent shows, and what the law itself provides — and name the Act and section when you rely on a statute. If the sources don't answer the question, say so rather than guessing. Write in Markdown: headings only when they help, short paragraphs, lists for lists, tables for genuinely tabular comparisons.${docsBlock}${sourcesBlock}${skillBlock}`;

          const historyTurns = priorMessages.map((m: any) => ({
            role: m.role,
            content: String(m.content).replace(/\[\[artifact:([^\]]+)\]\]/g, "[a document was produced here and is open in the panel]"),
          }));
          // On a continuation the original question is already the last turn in
          // the history — appending it again would ask it twice.
          const anthropicMessages = isContinuation
            ? historyTurns
            : [...historyTurns, { role: "user", content: message || `(attached ${attachments.map((a) => a.name).join(", ")})` }];

          const { text: fullText, generated, incomplete, stoppedByClient } = await anthropicComplete(
            anthropicKey,
            { model: CHAT_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: anthropicMessages },
            (d) => send("delta", { text: d }),
            { initialText: resumeMessage?.content ?? "", deadlineAt: startedAt + GENERATION_BUDGET_MS, clientSignal: req.signal },
          );

          const artifactData: Record<string, unknown> = {
            ...(documentType ? { documentTypeId: documentType.id, documentTypeName: documentType.name } : {}),
            ...(editBase
              ? { editSource: editBase.editSource, ...(!documentType && editBase.documentTypeId ? { documentTypeId: editBase.documentTypeId } : {}) }
              : {}),
          };
          const defaultTitle = editBase ? String((editBase.editSource as any).title) : `Draft: ${documentType?.name ?? "document"}`;

          // The lawyer pressed Stop. Keep what was written as a finished (if
          // short) reply — no continuation, they asked it to stop.
          if (stoppedByClient) {
            await persistReply(supabase, {
              threadId, matterId, userId: user.id, text: fullText, messageId: resumeMessage?.id ?? null,
              metadata: { sources: sourceSummaries, skill: skill ?? null, stopped: true }, artifactData, defaultTitle,
            });
            controller.close();
            return;
          }

          // Out of time, not out of document. Save the partial exactly as
          // written — artifact markup and all, so the next invocation resumes
          // mid-tag if that is where it stopped — and tell the client to come
          // straight back for the rest.
          if (incomplete) {
            const partialMetadata = { sources: sourceSummaries, skill: skill ?? null, incomplete: true };
            let partialId = resumeMessage?.id ?? null;
            if (partialId) {
              await supabase.from("ai_chat_messages")
                .update({ content: fullText, metadata: partialMetadata })
                .eq("id", partialId);
            } else {
              const { data } = await supabase.from("ai_chat_messages")
                .insert({ thread_id: threadId, role: "assistant", content: fullText, metadata: partialMetadata })
                .select("id")
                .single();
              partialId = data?.id ?? null;
            }
            // generatedChars lets the client tell "still writing, come back" from
            // "this round produced nothing", which would otherwise loop.
            send("done", { assistantMessageId: partialId, threadId, incomplete: true, generatedChars: generated.length });
            controller.close();
            return;
          }

          const { assistantMessageId } = await persistReply(supabase, {
            threadId, matterId, userId: user.id, text: fullText, messageId: resumeMessage?.id ?? null,
            metadata: { sources: sourceSummaries, skill: skill ?? null }, artifactData, defaultTitle, send,
          });

          // ---- a real title once there's something to name ----
          if (!isContinuation && (isNewThread || priorMessages.length === 0)) {
            try {
              const t = await anthropicJson(anthropicKey, {
                model: TITLE_MODEL, max_tokens: 30,
                system: "Give this legal conversation a title of at most six words, in plain sentence case, no quotes, no trailing punctuation. Reply with the title only.",
                messages: [{ role: "user", content: `Lawyer: ${message.slice(0, 600)}\n\nAssistant: ${fullText.slice(0, 600)}` }],
              });
              const title = String(t.content?.find((b: any) => b.type === "text")?.text ?? "").trim().replace(/^["']|["']$/g, "");
              if (title) {
                await supabase.from("ai_chat_threads").update({ title }).eq("id", threadId);
                send("title", { title });
              }
            } catch { /* a missing title is not worth failing the turn */ }
          }

          send("done", { assistantMessageId, threadId, incomplete: false });
          controller.close();
        } catch (err) {
          console.error("chat error:", err);
          send("error", { message: err instanceof Error ? err.message : String(err) });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});
