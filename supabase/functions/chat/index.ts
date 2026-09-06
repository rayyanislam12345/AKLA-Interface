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
  key: "draft" | "verify" | "summarise" | "custom";
  documentTypeId?: string;
  customSkillId?: string;
}

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

const ARTIFACT_RULES = `When you produce a complete document (a draft, a memo, a note), wrap ONLY the document itself in an artifact block so it opens in its own panel:
<artifact kind="draft|memo" title="Short document title">
…the document in Markdown…
</artifact>
Everything outside the block is your normal reply to the lawyer (keep that short — a sentence or two about what you did or need). Never put commentary inside the block. If you revise a document already produced in this conversation, output the FULL revised document in a new artifact block with the same title.`;

function sse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function deriveTitle(message: string, skill: Skill | null, documentTypeName: string | null): string {
  if (skill?.key === "draft" && documentTypeName) return `Draft: ${documentTypeName}`;
  if (skill?.key === "verify") return "Review";
  if (skill?.key === "summarise") return "Summary";
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

// Streams an Anthropic messages call, invoking onDelta for each text delta,
// and resolves with the full text.
async function anthropicStream(
  apiKey: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!resp.ok || !resp.body) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
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
        } else if (payload.type === "error") {
          throw new Error(payload.error?.message ?? "stream error");
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  return full;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
  } = body as { matterId: string; threadId?: string | null; message: string; attachments?: Attachment[]; skill?: Skill | null };

  if (!matterId) return json(400, { error: "matterId is required" });
  if (!message.trim() && rawAttachments.length === 0) return json(400, { error: "Say something or attach a document" });

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
  const [{ data: matter }, { data: parties }, { data: matterContext }, { data: relevantLaws }, documentTypeResult, customSkillResult] =
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
    ]);
  if (!matter) return json(404, { error: "Matter not found" });
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

  const { data: history } = await supabase
    .from("ai_chat_messages")
    .select("id, role, content, metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);
  const priorMessages = (history ?? []).reverse();

  const attachments: Attachment[] = (rawAttachments as Attachment[]).map((a) => ({
    bucket: a.bucket,
    path: a.path,
    name: a.name,
    size: a.size,
    type: a.type,
    matterDocumentId: a.matterDocumentId,
    versionId: a.versionId,
  }));

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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => sse(controller, encoder, event, data);

      (async () => {
        try {
          send("meta", { threadId, userMessageId: userMessage.id, title: thread!.title });

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
          if (attachments.length > 0) {
            await supabase.from("ai_chat_messages").update({ metadata: { attachments, skill: skill ?? null } }).eq("id", userMessage.id);
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
              throw new Error("Attach one of this matter's documents (Add from matter) to review it.");
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
              text += await anthropicStream(anthropicKey, { model: CHAT_MODEL, max_tokens: 700, system: summaryPrompt, messages: [{ role: "user", content: "Summarise the review." }] }, (d) => send("delta", { text: d }));
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
            send("done", { assistantMessageId: assistantMsg?.id, threadId });
            controller.close();
            return;
          }

          // ---- retrieval: the same three searches rag-query runs ----
          const retrievalQuery = [message, ...attachments.map((a) => a.name)].join("\n").slice(0, 8000) || documentType?.name || "";
          let sources: Array<Match & { scope: Scope }> = [];
          let templateHtml: string | null = null;
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
                  ? supabase.from("document_type_templates").select("content_html").eq("document_type_id", documentType.id).maybeSingle()
                  : Promise.resolve({ data: null }),
              ]);
              sources = [
                ...((m.data ?? []) as Match[]).map((x) => ({ ...x, scope: "matter" as const })),
                ...((p.data ?? []) as Match[]).map((x) => ({ ...x, scope: "precedent" as const })),
                ...((s.data ?? []) as Match[]).map((x) => ({ ...x, scope: "statute" as const })),
              ];
              templateHtml = (t as any)?.data?.content_html ?? null;
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
            ? `\nParties on the matter: ${(parties ?? []).map((p: any) => `${p.name} (${p.role})`).join("; ")}.`
            : "";
          const contextBlock = matterContext?.content?.trim()
            ? `\n\nCONTEXT CARRIED FORWARD ON THIS MATTER (curated by the team):\n${matterContext.content.trim()}`
            : "";
          const docsBlock = contextDocs.length
            ? `\n\nDOCUMENTS THE LAWYER HAS ATTACHED IN THIS CONVERSATION (read in full; treat as this matter's own material):\n` +
              contextDocs.map((a) => `<document name="${a.name}"${a.chars && a.chars > (a.text?.length ?? 0) ? ` note="truncated to first ${a.text!.length} of ${a.chars} characters"` : ""}>\n${a.text}\n</document>`).join("\n\n")
            : "";
          const label = (d: Match & { scope: Scope }, i: number) => {
            if (d.scope === "statute") return `[Source ${i + 1}] (statute — ${d.metadata?.act_name ?? "unknown Act"})`;
            const fn = d.metadata?.filename ? ` — ${d.metadata.filename}` : "";
            return `[Source ${i + 1}] (${d.scope === "matter" ? "this matter's document" : "precedent library"}${fn})`;
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
            const templateBlock = templateHtml?.trim()
              ? `\n\nSTANDARD TEMPLATE FOR THIS DOCUMENT TYPE — the firm's canonical structure and formatting for a ${documentType.name}. Follow its clause structure as the primary basis; the precedent excerpts above are for phrasing and edge cases:\n${templateHtml}`
              : "";
            skillBlock = `\n\nSKILL IN FORCE — DRAFT A "${documentType.name}" (${documentType.category}) FOR THIS MATTER.${reqFields}${templateBlock}

How to work: you are conducting a short intake, then drafting. If the conversation does not yet give you the essentials — parties and roles, term, payment or tariff structure, performance security, governing law, dispute resolution, termination, and anything specific to this document type — ask ONE focused question at a time (short, concrete). Stop asking as soon as you have enough for a solid first version, or the moment the lawyer says to draft now / just draft. Then draft the COMPLETE document: proper drafting conventions (defined terms capitalised on first use, recitals, operative clauses, execution block), and a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] wherever a specific commercial term wasn't given rather than an invented figure. This is a first draft for a lawyer to edit, not a final.

${FIRM_MARKDOWN_RULES}

${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="draft"')}`;
          } else if (skill?.key === "summarise") {
            skillBlock = `\n\nSKILL IN FORCE — "NOTES ON …" MEMO. Explain the attached (or discussed) document in plain English for a busy lawyer, as a short memo in the firm's house style: a "# Notes On <document>" title, then "## " sections — What it does; The points that matter (short numbered points via "- " list items, each one idea); What to watch. Tight and selective, not an exhaustive clause list. If nothing was attached and nothing was retrieved, say what you need.

${FIRM_MARKDOWN_RULES}

${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="memo"')}`;
          } else if (skill?.key === "custom" && customSkill) {
            skillBlock = `\n\nSKILL IN FORCE — "${customSkill.name}" (the firm's own instructions):\n${customSkill.instructions}` +
              (customSkill.produces_document ? `\n\n${FIRM_MARKDOWN_RULES}\n\n${ARTIFACT_RULES.replace('kind="draft|memo"', 'kind="memo"')}` : "");
          } else {
            skillBlock = `\n\n${ARTIFACT_RULES}`;
          }

          const systemPrompt = `You are the AI assistant inside AKLA Matter Hub, the internal system of Ali Khan Law Associates, a Pakistani corporate, projects and PPP law firm. You are working with a lawyer on the matter "${matter.name}"${clientName ? ` (client: ${clientName})` : ""}${matter.sector ? `, sector: ${matter.sector}` : ""}.${matter.description ? `\nMatter description: ${matter.description}` : ""}${partiesLine}${contextBlock}

You answer the way a careful senior associate would: precise, conservative, and honest about the limits of what the sources show. Ground every legal statement in the retrieved sources or the attached documents and cite them by number (e.g. [Source 2]); distinguish clearly between what THIS matter's documents say, what the firm's precedent shows, and what the law itself provides — and name the Act and section when you rely on a statute. If the sources don't answer the question, say so rather than guessing. Write in Markdown: headings only when they help, short paragraphs, lists for lists, tables for genuinely tabular comparisons.${docsBlock}${sourcesBlock}${skillBlock}`;

          const anthropicMessages = [
            ...priorMessages.map((m: any) => ({
              role: m.role,
              content: String(m.content).replace(/\[\[artifact:([^\]]+)\]\]/g, "[a document was produced here and is open in the panel]"),
            })),
            { role: "user", content: message || `(attached ${attachments.map((a) => a.name).join(", ")})` },
          ];

          const fullText = await anthropicStream(
            anthropicKey,
            { model: CHAT_MODEL, max_tokens: 12_000, system: systemPrompt, messages: anthropicMessages },
            (d) => send("delta", { text: d }),
          );

          // ---- artifacts the model produced ----
          const artifactIds: string[] = [];
          let content = fullText;
          const re = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
          let match: RegExpExecArray | null;
          const replacements: Array<[string, string]> = [];
          while ((match = re.exec(fullText)) !== null) {
            const attrs = match[1];
            const kindAttr = /kind="([^"]+)"/.exec(attrs)?.[1];
            const kind = kindAttr === "draft" ? "draft" : "memo";
            const title = /title="([^"]+)"/.exec(attrs)?.[1] ?? (kind === "draft" ? `Draft: ${documentType?.name ?? "document"}` : "Memo");
            const body = match[2].trim();
            const { data: artifact } = await supabase
              .from("ai_artifacts")
              .insert({
                thread_id: threadId,
                matter_id: matterId,
                kind,
                title,
                content: body,
                data: documentType ? { documentTypeId: documentType.id, documentTypeName: documentType.name } : {},
                created_by: user.id,
              })
              .select("*")
              .single();
            if (artifact) {
              artifactIds.push(artifact.id);
              replacements.push([match[0], `[[artifact:${artifact.id}]]`]);
              send("artifact", artifact);
            }
          }
          for (const [from, to] of replacements) content = content.replace(from, to);

          const { data: assistantMsg } = await supabase
            .from("ai_chat_messages")
            .insert({
              thread_id: threadId,
              role: "assistant",
              content: content.trim(),
              metadata: { sources: sourceSummaries, artifacts: artifactIds, skill: skill ?? null },
            })
            .select("id")
            .single();
          if (assistantMsg && artifactIds.length) {
            await supabase.from("ai_artifacts").update({ message_id: assistantMsg.id }).in("id", artifactIds);
          }

          // ---- a real title once there's something to name ----
          if (isNewThread || priorMessages.length === 0) {
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

          send("done", { assistantMessageId: assistantMsg?.id ?? null, threadId });
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
