// The AI Workspace's chat endpoint — supabase/functions/chat/index.ts ported
// to Node so it can run on the Oracle VM instead of a Supabase Edge Function.
//
// The one thing that changes by moving: there is no ~150s wall-clock kill
// here, so a reply of any length is written in a single pass. The edge
// version had to stop itself at 115s, save a partial, and have the browser
// call back with continueMessageId — every resume replaying the whole
// grounded prompt. That deadline is gone. continueMessageId is still
// accepted so a reply the edge function left half-written can be finished
// here, and so the client is identical whichever endpoint it is pointed at.
//
// Everything else — thread and message handling, attachments, the three
// library searches, the skills, artifact extraction — is the edge function's
// logic line for line. Keep the two in step until the edge function is
// retired (README: "Cutting over, and cutting back").
import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { extractTextFromFile } from "./extractText.js";

const PORT = Number(process.env.PORT ?? 8092);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, VOYAGE_API_KEY: VOYAGE_KEY })) {
  if (!value) console.error(`chat-service: ${name} is not set`);
}

let deployedVersion = {};
try {
  deployedVersion = JSON.parse(readFileSync(new URL("./DEPLOYED_VERSION", import.meta.url), "utf8"));
} catch { /* running from a checkout, not a deploy */ }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const CHAT_MODEL = "claude-sonnet-5";
const TITLE_MODEL = "claude-haiku-4-5-20251001";
const MAX_HISTORY = 30;
const MAX_ATTACHMENT_CHARS = 60_000;
const MAX_ATTACHMENTS_TOTAL_CHARS = 160_000;
const MAX_TOKENS = 32_000;
// max_tokens is a real per-call ceiling regardless of where this runs; a
// long agreement can need several calls. With no wall clock to respect the
// cap is generous — 8 × 32k tokens is far beyond any document the firm writes.
const MAX_CONTINUATIONS = 8;
const MATCH_THRESHOLD = 0.35;
// A retrieved chunk is normally a few thousand characters, but a handful of
// legacy rows hold a whole document (the largest is 11MB).
const MAX_SOURCE_CHARS = 8_000;
const MAX_EDIT_CHARS = 150_000;
const MAX_REFERENCED_DOCS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

// How a half-written reply is picked up again. This model rejects assistant
// prefill outright, so the partial goes in as a normal assistant turn and
// this follows it as the user turn. Blunt on purpose: the model's instinct
// is to greet, recap, or start over.
function continueInstruction(partial) {
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
// here: paired — "services agreement" — it is exactly how lawyers name a
// file, and the two-word threshold below stops it matching alone.
const REFERENCE_STOPWORDS = new Set([
  "the", "of", "and", "for", "to", "a", "an", "on", "in", "with", "by", "re", "draft", "final", "clean",
  "version", "doc", "copy", "execution", "signed", "revised", "updated", "latest", "current",
]);

function normaliseWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

// Which of the project's documents a message is talking about. An exact
// title or filename is certain; otherwise at least two of the title's
// distinctive words; failing that a document type the project has one of.
// "v2" / "version 2" picks the version, otherwise the latest.
function resolveReferences(message, docs, excludeDocId) {
  const msgWords = normaliseWords(message);
  const msgSet = new Set(msgWords);
  const msgNorm = ` ${msgWords.join(" ")} `;
  const versionAsk = /\b(?:v|version\s*)(\d{1,3})\b/i.exec(message);
  const pickVersion = (doc) => {
    const sorted = [...doc.versions].sort((a, b) => b.version_number - a.version_number);
    if (versionAsk) {
      const want = sorted.find((v) => v.version_number === Number(versionAsk[1]));
      if (want) return want;
    }
    return sorted[0];
  };

  const scored = [];
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
  const hits = scored.map(({ doc, version }) => ({ doc, version }));

  if (!hits.length) {
    const byType = new Map();
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

function deriveTitle(message, skill, documentTypeName) {
  if (skill?.key === "draft" && documentTypeName) return `Draft: ${documentTypeName}`;
  if (skill?.key === "verify") return "Review";
  if (skill?.key === "summarise") return "Summary";
  if (skill?.key === "edit") return "Edit";
  const firstLine = message.trim().split("\n")[0].replace(/\s+/g, " ");
  return firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + "…" : firstLine || "New chat";
}

async function anthropicJson(body) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

// Streams one messages call. Resolves with the text and why generation
// stopped — "max_tokens" means cut off mid-sentence, which the caller has to
// handle rather than pass off as finished.
async function anthropicStreamOnce(body, onDelta, signal) {
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") return { text: "", stopReason: null, aborted: true };
    throw err;
  }
  if (!resp.ok || !resp.body) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let stopReason = null;
  let aborted = false;
  while (true) {
    let value;
    try {
      const chunk = await reader.read();
      if (chunk.done) break;
      value = chunk.value;
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
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

// Generates until the answer is finished, the lawyer presses Stop, or the
// model stops producing. `initialText` is a partial an earlier invocation
// wrote; it is replayed as an assistant turn plus a continue instruction.
async function anthropicComplete(body, onDelta, { initialText = "", clientSignal }) {
  const baseMessages = body.messages ?? [];
  let accumulated = initialText;
  let generated = "";
  let incomplete = false;
  let stoppedByClient = false;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    // Not trimmed: a trailing newline tells the model whether the text
    // stopped mid-line, and stripping it welds clauses together.
    const messages = accumulated
      ? [...baseMessages, { role: "assistant", content: accumulated }, { role: "user", content: continueInstruction(accumulated) }]
      : baseMessages;

    const result = await anthropicStreamOnce({ ...body, messages }, onDelta, clientSignal);
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
    if (!result.text) break;
    if (attempt === MAX_CONTINUATIONS) incomplete = true;
  }
  return { text: accumulated, generated, incomplete, stoppedByClient };
}

// Turns raw model output into a stored reply: every <artifact> block becomes
// an ai_artifacts row and an [[artifact:id]] marker in the text. An
// unterminated block is closed rather than lost.
async function persistReply(supabase, p) {
  const opened = (p.text.match(/<artifact\s/g) ?? []).length;
  const closed = (p.text.match(/<\/artifact>/g) ?? []).length;
  const truncated = opened > closed;
  const modelText = truncated ? `${p.text}\n</artifact>` : p.text;

  const artifactIds = [];
  let content = modelText;
  const re = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
  let match;
  const replacements = [];
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
  // A stray tag with no partner — the model sometimes closes an artifact
  // twice — would otherwise sit in the reply as literal text.
  content = content.replace(/<\/?artifact\b[^>]*>/g, "").trim();

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------

async function handleChat(req, res) {
  const startedAt = Date.now();
  const json = (status, body) => {
    res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(400, { error: err.message });
  }
  const {
    matterId,
    threadId: requestedThreadId = null,
    message = "",
    attachments: rawAttachments = [],
    skill = null,
    continueMessageId = null,
  } = body;
  const isContinuation = !!continueMessageId;

  if (!matterId) return json(400, { error: "matterId is required" });
  if (isContinuation && !requestedThreadId) return json(400, { error: "threadId is required to continue a reply" });
  if (!isContinuation && !message.trim() && rawAttachments.length === 0) {
    return json(400, { error: "Say something or attach a document" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) return json(401, { error: "Authorization header required" });
  if (!ANTHROPIC_KEY) return json(500, { error: "Anthropic API key not configured" });
  if (!VOYAGE_KEY) return json(500, { error: "Voyage API key not configured" });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } = {}, error: userError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
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
  const projectDocs = projectDocsResult.data ?? [];
  const documentType = documentTypeResult.data;
  const customSkill = customSkillResult.data;

  // ---- thread + the lawyer's message, before any streaming so a failure is visible ----
  let thread = null;
  if (requestedThreadId) {
    const { data } = await supabase.from("ai_chat_threads").select("id, title, skill").eq("id", requestedThreadId).single();
    thread = data;
  }
  const isNewThread = !thread;
  if (!thread) {
    const { data, error } = await supabase
      .from("ai_chat_threads")
      .insert({ matter_id: matterId, title: deriveTitle(message, skill, documentType?.name ?? null), created_by: user.id, skill: skill ?? null })
      .select("id, title, skill")
      .single();
    if (error || !data) return json(500, { error: `Could not create the conversation: ${error?.message}` });
    thread = data;
  } else if (skill && !thread.skill) {
    await supabase.from("ai_chat_threads").update({ skill }).eq("id", thread.id);
  }
  const threadId = thread.id;

  let resumeMessage = null;
  if (isContinuation) {
    const { data } = await supabase
      .from("ai_chat_messages")
      .select("id, content")
      .eq("id", continueMessageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (!data) return json(404, { error: "The reply to continue no longer exists" });
    resumeMessage = data;
  }

  const { data: history } = await supabase
    .from("ai_chat_messages")
    .select("id, role, content, metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);
  const priorMessages = (history ?? []).reverse().filter((m) => m.id !== continueMessageId);

  // ---- edit: the document being worked on ----
  // The newest draft artifact in this thread — the version as uploaded on the
  // first turn, the latest AI edit after — so a conversation refines one
  // document iteratively. A thread with no artifact reads the version itself.
  let editBase = null;
  if (skill?.key === "edit") {
    const { data: latest } = await supabase
      .from("ai_artifacts")
      .select("content, data")
      .eq("thread_id", threadId)
      .eq("kind", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const d = latest?.data ?? {};
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
          const md = v.matter_document;
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

  const attachments = rawAttachments.map((a) => ({
    bucket: a.bucket, path: a.path, name: a.name, size: a.size, type: a.type,
    matterDocumentId: a.matterDocumentId, versionId: a.versionId,
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

  let userMessageId = null;
  if (!isContinuation) {
    const { data: userMessage, error: userMsgError } = await supabase
      .from("ai_chat_messages")
      .insert({ thread_id: threadId, role: "user", content: message, created_by: user.id, metadata: { attachments, skill: skill ?? null } })
      .select("id")
      .single();
    if (userMsgError || !userMessage) return json(500, { error: `Could not save the message: ${userMsgError?.message}` });
    userMessageId = userMessage.id;
  }

  // ---- from here on the reply streams as server-sent events ----
  res.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.socket?.setTimeout(0);
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // The lawyer pressing Stop closes the connection; that has to reach the
  // upstream model stream, or it keeps writing (and billing) to the end.
  const clientGone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) clientGone.abort();
  });
  const finish = () => {
    if (!res.writableEnded) res.end();
  };

  try {
    send("meta", { threadId, userMessageId, title: thread.title, continuing: isContinuation });
    for (const { doc, version } of referenced) {
      send("notice", { text: `Reading ${doc.title} (v${version.version_number}) from the project.` });
    }

    // ---- attachments: read now, remember the text on the message ----
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

    // Documents attached earlier in this conversation stay in context,
    // deduplicated by path, newest first, within a budget.
    const contextDocs = [];
    const seen = new Set();
    const candidates = [
      ...attachments,
      ...[...priorMessages].reverse().flatMap((m) => (m.role === "user" ? (m.metadata?.attachments ?? []) : [])),
    ];
    for (const a of candidates) {
      const key = `${a.bucket}/${a.path}`;
      if (seen.has(key) || !a.text) continue;
      if (totalChars > MAX_ATTACHMENTS_TOTAL_CHARS && !attachments.includes(a)) break;
      seen.add(key);
      contextDocs.push(a);
      totalChars += a.text.length;
    }

    // ---- verify: the existing three-pass engine, still on Supabase ----
    if (skill?.key === "verify") {
      const target = attachments.find((a) => a.versionId) ?? contextDocs.find((a) => a.versionId);
      if (!target?.versionId) throw new Error("Attach one of this project's documents (Add from project) to review it.");
      const reviewResp = await fetch(`${SUPABASE_URL}/functions/v1/suggest-redline`, {
        method: "POST",
        headers: { Authorization: authHeader, apikey: SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ documentVersionId: target.versionId }),
      });
      if (!reviewResp.ok) throw new Error(`Review failed: ${(await reviewResp.text()).slice(0, 200)}`);
      const review = await reviewResp.json();
      const suggestions = review.suggestions ?? [];
      const byType = {};
      for (const s of suggestions) byType[s.review_type] = (byType[s.review_type] ?? 0) + 1;

      const artifactData = {
        documentVersionId: target.versionId,
        matterDocumentId: target.matterDocumentId ?? null,
        suggestionCount: suggestions.length,
        byType,
      };

      let instructionReply = "";
      if (message.trim()) {
        try {
          const rcResp = await fetch(`${SUPABASE_URL}/functions/v1/redline-chat`, {
            method: "POST",
            headers: { Authorization: authHeader, apikey: SERVICE_KEY, "Content-Type": "application/json" },
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
        text += (await anthropicStreamOnce({ model: CHAT_MODEL, max_tokens: 700, system: summaryPrompt, messages: [{ role: "user", content: "Summarise the review." }] }, (d) => send("delta", { text: d }))).text;
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
      finish();
      return;
    }

    // ---- retrieval: the same three searches rag-query runs ----
    const lastUserMessage = [...priorMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const effectiveMessage = message || lastUserMessage;
    const retrievalQuery = [effectiveMessage, ...attachments.map((a) => a.name)].join("\n").slice(0, 8000) || documentType?.name || "";
    let sources = [];
    let templateHtml = null;
    let templateRules = null;
    if (retrievalQuery) {
      const embResp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "voyage-law-2", input: [retrievalQuery], input_type: "query" }),
      });
      if (embResp.ok) {
        const queryEmbedding = (await embResp.json()).data[0].embedding;
        const actNames = (relevantLaws ?? []).map((r) => r.act_name).filter(Boolean);
        const statuteParams = { query_embedding: queryEmbedding, match_threshold: MATCH_THRESHOLD, match_count: 4, statute_only: true };
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
          ...(m.data ?? []).map((x) => ({ ...x, scope: "matter" })),
          ...(p.data ?? []).map((x) => ({ ...x, scope: "precedent" })),
          ...(s.data ?? []).map((x) => ({ ...x, scope: "statute" })),
        ];
        templateHtml = t?.data?.content_html ?? null;
        templateRules = t?.data?.format_rules ?? null;
      } else {
        console.error(`voyage embeddings ${embResp.status}: ${(await embResp.text()).slice(0, 200)}`);
      }
    }
    const sourceSummaries = sources.map((d) => ({
      id: d.id, scope: d.scope, similarity: d.similarity,
      filename: d.metadata?.filename ?? null, act_name: d.metadata?.act_name ?? null,
      content: String(d.content ?? "").slice(0, 240),
    }));
    send("sources", sourceSummaries);

    // ---- the system prompt ----
    const clientName = matter.client?.name;
    const partiesLine = (parties ?? []).length
      ? `\nParties on the project: ${(parties ?? []).map((p) => `${p.name} (${p.role})`).join("; ")}.`
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
        contextDocs.map((a) => `<document name="${a.name}"${a.chars && a.chars > (a.text?.length ?? 0) ? ` note="truncated to first ${a.text.length} of ${a.chars} characters"` : ""}>\n${a.text}\n</document>`).join("\n\n")
      : "";
    const label = (d, i) => {
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
      const reqFields = Array.isArray(documentType.required_fields) && documentType.required_fields.length
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
      const src = editBase.editSource;
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

    const historyTurns = priorMessages.map((m) => ({
      role: m.role,
      content: String(m.content).replace(/\[\[artifact:([^\]]+)\]\]/g, "[a document was produced here and is open in the panel]"),
    }));
    const anthropicMessages = isContinuation
      ? historyTurns
      : [...historyTurns, { role: "user", content: message || `(attached ${attachments.map((a) => a.name).join(", ")})` }];

    const { text: fullText, generated, incomplete, stoppedByClient } = await anthropicComplete(
      { model: CHAT_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: anthropicMessages },
      (d) => send("delta", { text: d }),
      { initialText: resumeMessage?.content ?? "", clientSignal: clientGone.signal },
    );

    const artifactData = {
      ...(documentType ? { documentTypeId: documentType.id, documentTypeName: documentType.name } : {}),
      ...(editBase
        ? { editSource: editBase.editSource, ...(!documentType && editBase.documentTypeId ? { documentTypeId: editBase.documentTypeId } : {}) }
        : {}),
    };
    const defaultTitle = editBase ? String(editBase.editSource.title) : `Draft: ${documentType?.name ?? "document"}`;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (stoppedByClient) {
      await persistReply(supabase, {
        threadId, matterId, userId: user.id, text: fullText, messageId: resumeMessage?.id ?? null,
        metadata: { sources: sourceSummaries, skill: skill ?? null, stopped: true }, artifactData, defaultTitle,
      });
      console.log(`chat thread=${threadId} skill=${skill?.key ?? "-"} stopped by client after ${elapsed}s, ${generated.length} chars`);
      finish();
      return;
    }

    // Only reachable now if the model needed more than MAX_CONTINUATIONS
    // calls. Saved as a partial the client can resume, same as the edge
    // function did at its deadline.
    if (incomplete) {
      const partialMetadata = { sources: sourceSummaries, skill: skill ?? null, incomplete: true };
      let partialId = resumeMessage?.id ?? null;
      if (partialId) {
        await supabase.from("ai_chat_messages").update({ content: fullText, metadata: partialMetadata }).eq("id", partialId);
      } else {
        const { data } = await supabase.from("ai_chat_messages")
          .insert({ thread_id: threadId, role: "assistant", content: fullText, metadata: partialMetadata })
          .select("id")
          .single();
        partialId = data?.id ?? null;
      }
      console.log(`chat thread=${threadId} skill=${skill?.key ?? "-"} incomplete after ${elapsed}s, ${generated.length} chars`);
      send("done", { assistantMessageId: partialId, threadId, incomplete: true, generatedChars: generated.length });
      finish();
      return;
    }

    const { assistantMessageId } = await persistReply(supabase, {
      threadId, matterId, userId: user.id, text: fullText, messageId: resumeMessage?.id ?? null,
      metadata: { sources: sourceSummaries, skill: skill ?? null }, artifactData, defaultTitle, send,
    });

    if (!isContinuation && (isNewThread || priorMessages.length === 0)) {
      try {
        const t = await anthropicJson({
          model: TITLE_MODEL, max_tokens: 30,
          system: "Give this legal conversation a title of at most six words, in plain sentence case, no quotes, no trailing punctuation. Reply with the title only.",
          messages: [{ role: "user", content: `Lawyer: ${message.slice(0, 600)}\n\nAssistant: ${fullText.slice(0, 600)}` }],
        });
        const title = String(t.content?.find((b) => b.type === "text")?.text ?? "").trim().replace(/^["']|["']$/g, "");
        if (title) {
          await supabase.from("ai_chat_threads").update({ title }).eq("id", threadId);
          send("title", { title });
        }
      } catch { /* a missing title is not worth failing the turn */ }
    }

    console.log(`chat thread=${threadId} skill=${skill?.key ?? "-"} done in ${elapsed}s, ${generated.length} chars, ${sources.length} sources`);
    send("done", { assistantMessageId, threadId, incomplete: false });
    finish();
  } catch (err) {
    console.error("chat error:", err);
    send("error", { message: err instanceof Error ? err.message : String(err) });
    finish();
  }
}

// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/version")) {
    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "chat-service", ...deployedVersion }));
    return;
  }
  if (req.method === "POST" && (url.pathname === "/chat" || url.pathname === "/")) {
    handleChat(req, res).catch((err) => {
      console.error("chat handler crashed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    return;
  }
  res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Node's default requestTimeout is 300s — a long draft would trip it. The
// whole point of being here is that a reply can take as long as it takes.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`chat-service listening on 127.0.0.1:${PORT}${deployedVersion.commit ? ` (${deployedVersion.commit.slice(0, 8)})` : ""}`);
});
