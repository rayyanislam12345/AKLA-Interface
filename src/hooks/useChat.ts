import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { Json, Tables } from "@/integrations/supabase/types";
import { sanitizeStorageFilename } from "@/lib/utils";

// Data layer for the AI Workspace chat: threads per matter, their messages,
// the streaming send, custom skills and artifacts. The `chat` edge function
// owns all the writes that happen during a turn; these hooks only read them
// back and patch the cache as stream events arrive.

export type ChatThread = Tables<"ai_chat_threads">;
export type ChatMessage = Tables<"ai_chat_messages">;
export type ChatArtifact = Tables<"ai_artifacts">;
export type CustomSkill = Tables<"ai_skills">;

export interface ChatAttachment {
  bucket: string;
  path: string;
  name: string;
  size?: number;
  type?: string;
  matterDocumentId?: string;
  versionId?: string;
  chars?: number;
}

export type SkillKey = "draft" | "verify" | "summarise" | "edit" | "custom";
export interface ActiveSkill {
  key: SkillKey;
  documentTypeId?: string;
  customSkillId?: string;
  // edit: the exact version being worked on
  documentVersionId?: string;
  matterDocumentId?: string;
  // Display-only, not sent: what the chip shows.
  label: string;
}

export interface ChatSource {
  id: string;
  scope: "matter" | "precedent" | "statute";
  similarity: number;
  filename: string | null;
  act_name: string | null;
  content: string;
}

export interface MessageMetadata {
  attachments?: ChatAttachment[];
  sources?: ChatSource[];
  artifacts?: string[];
  skill?: { key: SkillKey; documentTypeId?: string; customSkillId?: string; documentVersionId?: string; matterDocumentId?: string } | null;
  // The chat function saved this reply before it was finished (it ran out
  // of wall clock) and expects to be asked for the rest.
  incomplete?: boolean;
}

export function messageMetadata(m: ChatMessage): MessageMetadata {
  return (m.metadata ?? {}) as MessageMetadata;
}

// ---------------------------------------------------------------- threads

export function useChatThreads(matterId: string | undefined) {
  return useQuery({
    queryKey: ["chat-threads", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_chat_threads")
        .select("*")
        .eq("matter_id", matterId!)
        .order("pinned", { ascending: false })
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateChatThread(matterId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; title?: string; pinned?: boolean; archived?: boolean }) => {
      const { error } = await supabase.from("ai_chat_threads").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] }),
  });
}

export function useDeleteChatThread(matterId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("ai_chat_threads").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] }),
  });
}

// --------------------------------------------------------------- messages

export function useChatMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: ["chat-messages", threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_chat_messages")
        .select("*")
        .eq("thread_id", threadId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useThreadArtifacts(threadId: string | undefined) {
  return useQuery({
    queryKey: ["chat-artifacts", threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_artifacts")
        .select("*")
        .eq("thread_id", threadId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateArtifact(threadId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, content, title, data }: { id: string; content?: string; title?: string; data?: Json }) => {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (content !== undefined) patch.content = content;
      if (title !== undefined) patch.title = title;
      if (data !== undefined) patch.data = data;
      const { error } = await supabase.from("ai_artifacts").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chat-artifacts", threadId] }),
  });
}

// ----------------------------------------------------------------- skills

export function useCustomSkills() {
  return useQuery({
    queryKey: ["ai-skills"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_skills").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useSaveCustomSkill() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { id?: string; name: string; description: string; instructions: string; produces_document: boolean }) => {
      const { id, ...fields } = input;
      if (id) {
        const { error } = await supabase.from("ai_skills").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return id;
      }
      const { data, error } = await supabase
        .from("ai_skills")
        .insert({ ...fields, created_by: user?.id })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-skills"] }),
  });
}

export function useDeleteCustomSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("ai_skills").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-skills"] }),
  });
}

// ---------------------------------------------------------------- uploads

// A file dropped into the composer goes to the private ai-chat-files bucket,
// scoped to the matter, and is only read by the chat function. It is NOT a
// matter document — "Add to matter" from the chip is the deliberate step
// that makes it part of the record.
export async function uploadChatFile(matterId: string, file: File): Promise<ChatAttachment> {
  const path = `${matterId}/${Date.now()}-${sanitizeStorageFilename(file.name)}`;
  const { error } = await supabase.storage.from("ai-chat-files").upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;
  return { bucket: "ai-chat-files", path, name: file.name, size: file.size, type: file.type };
}

// ------------------------------------------------------------------ edit

export interface EditTarget {
  matterDocumentId: string;
  documentTypeId: string | null;
  title: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  storagePath: string;
}

// Opens one specific version of a project document for editing. The text is
// extracted server-side, a thread is started for the edit, and the document
// as it stands becomes that thread's first artifact — so the panel can show
// it the moment the associate picks it, before a word has been typed. Every
// AI edit that follows is saved as a further artifact with the same
// editSource, which is what "Save as new version" uses to version the right
// document.
export async function openDocumentForEdit(
  matterId: string,
  target: EditTarget,
  userId: string | undefined,
): Promise<{ threadId: string; artifact: ChatArtifact }> {
  const { data: extracted, error: extractError } = await supabase.functions.invoke("extract-document-text", {
    body: { bucket: "matter-documents", storagePath: target.storagePath, fileName: target.fileName },
  });
  if (extractError) throw extractError;
  const text = String(extracted?.text ?? "");
  if (!text.trim()) throw new Error("No text could be read from that file");

  const editSource = {
    matterDocumentId: target.matterDocumentId,
    documentVersionId: target.versionId,
    versionNumber: target.versionNumber,
    title: target.title,
    fileName: target.fileName,
  };
  const { data: thread, error: threadError } = await supabase
    .from("ai_chat_threads")
    .insert({
      matter_id: matterId,
      title: `Edit: ${target.title} (v${target.versionNumber})`,
      created_by: userId,
      skill: { key: "edit", documentVersionId: target.versionId, matterDocumentId: target.matterDocumentId },
    })
    .select("*")
    .single();
  if (threadError || !thread) throw threadError ?? new Error("Could not start the edit");

  const { data: artifact, error: artifactError } = await supabase
    .from("ai_artifacts")
    .insert({
      thread_id: thread.id,
      matter_id: matterId,
      kind: "draft",
      title: `${target.title} (v${target.versionNumber})`,
      content: text,
      data: { editSource, original: true, ...(target.documentTypeId ? { documentTypeId: target.documentTypeId } : {}) },
      created_by: userId,
    })
    .select("*")
    .single();
  if (artifactError || !artifact) throw artifactError ?? new Error("Could not open the document");
  return { threadId: thread.id, artifact };
}

// -------------------------------------------------------------- streaming

export interface StreamingState {
  threadId: string | null;
  text: string;
  sources: ChatSource[];
  notices: string[];
  artifacts: ChatArtifact[];
  error: string | null;
}

const EMPTY_STREAM: StreamingState = { threadId: null, text: "", sources: [], notices: [], artifacts: [], error: null };

interface SendInput {
  matterId: string;
  threadId: string | null;
  message: string;
  attachments: ChatAttachment[];
  skill: ActiveSkill | null;
}

// The chat function stops generating before Supabase kills it at ~150s of wall
// clock, saves what it wrote, and reports the turn unfinished. Asking again
// with continueMessageId starts a fresh invocation that resumes from exactly
// where the text stopped, so a long agreement finishes over as many rounds as
// it needs. This caps the rounds so a pathological loop can't run forever —
// at roughly two minutes of writing each, it is far more than any real
// document needs.
const MAX_CONTINUATION_ROUNDS = 12;

// One turn of the conversation: POST to the chat function, consume its SSE
// stream, and expose the partial reply as state so the message list can show
// it typing. On "done" the persisted rows are refetched and take over.
export function useSendChatMessage(onThreadCreated?: (threadId: string) => void, onArtifact?: (artifact: ChatArtifact) => void) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [stream, setStream] = useState<StreamingState>(EMPTY_STREAM);
  const [pending, setPending] = useState<{ content: string; attachments: ChatAttachment[] } | null>(null);
  // Set while a half-written reply is being picked up again, so the list can
  // show it as one growing message rather than the stored partial plus a
  // second bubble underneath.
  const [resumingMessageId, setResumingMessageId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // One request/response round against the chat function. Streams its events
  // into `stream` and reports back whether the reply is finished.
  const runRound = useCallback(
    async (
      matterId: string,
      payload: Record<string, unknown>,
      signal: AbortSignal,
      isFirstRound: boolean,
    ): Promise<{ threadId: string | null; assistantMessageId: string | null; incomplete: boolean; generatedChars: number }> => {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session!.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });
      if (!resp.ok || !resp.body) {
        let detail = `Request failed (${resp.status})`;
        try {
          detail = (await resp.json()).error ?? detail;
        } catch { /* not json */ }
        throw new Error(detail);
      }

      let roundThreadId: string | null = null;
      let assistantMessageId: string | null = null;
      let incomplete = false;
      let generatedChars = 0;

      const handle = (event: string, data: any) => {
        switch (event) {
          case "meta":
            roundThreadId = data.threadId;
            setStream((s) => ({ ...s, threadId: data.threadId }));
            if (isFirstRound && data.threadId) onThreadCreated?.(data.threadId);
            break;
          case "delta":
            setStream((s) => ({ ...s, text: s.text + data.text }));
            break;
          case "sources":
            setStream((s) => ({ ...s, sources: data }));
            break;
          case "notice":
            setStream((s) => ({ ...s, notices: [...s.notices, data.text] }));
            break;
          case "artifact":
            setStream((s) => ({ ...s, artifacts: [...s.artifacts, data] }));
            onArtifact?.(data);
            break;
          case "title":
            queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] });
            break;
          case "done":
            assistantMessageId = data.assistantMessageId ?? null;
            incomplete = !!data.incomplete;
            generatedChars = data.generatedChars ?? 0;
            break;
          case "error":
            throw new Error(data.message);
        }
      };

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
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
          if (!dataLine) continue;
          handle(event, JSON.parse(dataLine));
        }
      }
      return { threadId: roundThreadId, assistantMessageId, incomplete, generatedChars };
    },
    [session, queryClient, onThreadCreated, onArtifact],
  );

  // Keeps asking for the rest of a reply until it is genuinely finished. The
  // text keeps streaming into the same bubble, so this is invisible apart
  // from a short pause between rounds.
  const continueUntilDone = useCallback(
    async (
      matterId: string,
      threadId: string,
      first: { assistantMessageId: string | null; incomplete: boolean; generatedChars: number },
      skillPayload: Record<string, unknown> | null,
      signal: AbortSignal,
    ) => {
      let round = first;
      let rounds = 0;
      while (round.incomplete && round.assistantMessageId && rounds < MAX_CONTINUATION_ROUNDS) {
        rounds++;
        round = await runRound(
          matterId,
          { matterId, threadId, message: "", attachments: [], skill: skillPayload, continueMessageId: round.assistantMessageId },
          signal,
          false,
        );
        // A round that wrote nothing will not write anything next time
        // either — stop rather than burn the whole round budget.
        if (round.incomplete && round.generatedChars === 0) break;
      }
      if (round.incomplete) {
        setStream((s) => ({
          ...s,
          notices: [...s.notices, "This is running unusually long, so it stops here. Press Continue writing to carry on."],
        }));
      }
      return round;
    },
    [runRound],
  );

  const finishTurn = useCallback(
    async (matterId: string, threadId: string | null) => {
      const wasStopped = abortRef.current?.signal.aborted ?? false;
      abortRef.current = null;
      const refetch = () => {
        if (!threadId) return Promise.resolve();
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: ["chat-messages", threadId] }),
          queryClient.invalidateQueries({ queryKey: ["chat-artifacts", threadId] }),
        ]);
      };
      await refetch();
      // After Stop the function is still saving what was written when the
      // connection closed — this first refetch usually lands before that row
      // exists. Look again once it has had a moment.
      if (wasStopped) setTimeout(refetch, 2500);
      queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] });
      setPending(null);
      setResumingMessageId(null);
      setStream((s) => (s.error ? { ...s, text: "" } : EMPTY_STREAM));
    },
    [queryClient],
  );

  const send = useCallback(
    async ({ matterId, threadId, message, attachments, skill }: SendInput) => {
      if (!session?.access_token) throw new Error("Not signed in");
      const controller = new AbortController();
      abortRef.current = controller;
      setPending({ content: message, attachments });
      setStream({ ...EMPTY_STREAM, threadId });

      const skillPayload = skill
        ? {
            key: skill.key,
            documentTypeId: skill.documentTypeId,
            customSkillId: skill.customSkillId,
            documentVersionId: skill.documentVersionId,
            matterDocumentId: skill.matterDocumentId,
          }
        : null;
      let resolvedThreadId = threadId;
      try {
        let round = await runRound(
          matterId,
          { matterId, threadId, message, attachments, skill: skillPayload },
          controller.signal,
          !threadId,
        );
        resolvedThreadId = round.threadId ?? resolvedThreadId;

        if (resolvedThreadId) {
          await continueUntilDone(matterId, resolvedThreadId, round, skillPayload, controller.signal);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setStream((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
        }
      } finally {
        await finishTurn(matterId, resolvedThreadId);
      }
    },
    [session, runRound, continueUntilDone, finishTurn],
  );

  // Picks up a reply that was left half-written — the tab was closed, the
  // old client never asked for round two, or the round budget ran out — from
  // exactly where it stopped. The stored partial is what the model resumes
  // from, so nothing already written is regenerated.
  const resume = useCallback(
    async ({ matterId, threadId, message }: { matterId: string; threadId: string; message: ChatMessage }) => {
      if (!session?.access_token) throw new Error("Not signed in");
      const controller = new AbortController();
      abortRef.current = controller;
      const meta = messageMetadata(message);
      const skillPayload = meta.skill ?? null;
      setResumingMessageId(message.id);
      setPending({ content: "", attachments: [] });
      setStream({ ...EMPTY_STREAM, threadId, text: message.content });
      try {
        await continueUntilDone(
          matterId,
          threadId,
          { assistantMessageId: message.id, incomplete: true, generatedChars: 1 },
          skillPayload,
          controller.signal,
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setStream((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
        }
      } finally {
        await finishTurn(matterId, threadId);
      }
    },
    [session, continueUntilDone, finishTurn],
  );

  const clearError = useCallback(() => setStream(EMPTY_STREAM), []);

  return { send, resume, stop, stream, pending, sending: pending !== null, resumingMessageId, clearError };
}
