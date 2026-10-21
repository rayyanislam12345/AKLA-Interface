import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { type ChatArtifact, useThreadArtifacts } from "@/hooks/useChat";
import {
  beginDecision,
  chatApiBase,
  dataOf,
  decideChanges,
  endDecision,
  listChanges,
  workingDocumentIdOf,
  type ChangeCard,
  type ChangeCounts,
  type ChangesList,
  type Decision,
  type DecideResult,
} from "@/lib/documentSave";
import { beginCompanionBusy } from "@/lib/companionBusy";

// The Changes list of one working document (every copy of one Word file in
// a chat), read from the chat service. Keyed on the working document, so a
// Word artifact arriving from the chat stream for the same document
// (useChat invalidates ["document-changes", workingDocumentId]) and every
// decision refresh it. The panel shows what comes back verbatim: states,
// labels, notes and counts are the server's, never worked out here.

export const documentChangesKey = (workingDocumentId: string | null) => ["document-changes", workingDocumentId] as const;

export function useDocumentChanges(artifact: ChatArtifact | null) {
  const queryClient = useQueryClient();
  const available = !!chatApiBase();
  const isDocx = artifact?.kind === "docx";
  const workingDocumentId = artifact && isDocx ? workingDocumentIdOf(artifact) : null;
  const artifactId = artifact?.id ?? null;

  const list = useQuery({
    queryKey: documentChangesKey(workingDocumentId),
    enabled: available && !!workingDocumentId && !!artifactId,
    queryFn: () => listChanges(artifactId!),
    staleTime: 10_000,
    retry: 1,
  });

  const decide = useMutation({
    mutationFn: async (decisions: Decision[]): Promise<DecideResult> => {
      if (!artifactId || !workingDocumentId) throw new Error("No document is open.");
      beginDecision(workingDocumentId);
      const endBusy = beginCompanionBusy();
      try {
        return await decideChanges(artifactId, decisions);
      } finally {
        endDecision(workingDocumentId);
        endBusy();
      }
    },
    onSuccess: (result) => {
      const decided = new Map(result.changes.map((c) => [c.id, c]));
      const head = result.head;
      const d = dataOf(head);
      queryClient.setQueryData<ChangesList>(documentChangesKey(workingDocumentId), (old) =>
        old
          ? {
              ...old,
              workingDocumentId: result.workingDocumentId,
              head: { id: head.id, bucket: d.bucket ?? "ai-chat-files", storagePath: d.storagePath ?? null, fileName: d.fileName ?? null, title: head.title, updatedAt: head.updated_at ?? null },
              counts: result.counts,
              changes: old.changes.map((c) => decided.get(c.id) ?? c),
            }
          : old,
      );
      // The decided file is the head now: put its row into the chat's
      // artifacts so the panel and the chat open it straight away.
      queryClient.setQueryData<ChatArtifact[]>(["chat-artifacts", head.thread_id], (old) => {
        if (!old) return old;
        return old.some((a) => a.id === head.id) ? old.map((a) => (a.id === head.id ? head : a)) : [...old, head];
      });
      queryClient.invalidateQueries({ queryKey: documentChangesKey(workingDocumentId) });
      queryClient.invalidateQueries({ queryKey: ["chat-artifacts", head.thread_id] });
    },
    onError: () => {
      // A 409 means the document moved on meanwhile: show where it is now.
      queryClient.invalidateQueries({ queryKey: documentChangesKey(workingDocumentId) });
      if (artifact) queryClient.invalidateQueries({ queryKey: ["chat-artifacts", artifact.thread_id] });
    },
  });

  return { list, decide, available, workingDocumentId };
}

const time = (a: ChatArtifact) => Date.parse(a.updated_at ?? a.created_at ?? "") || 0;
const freshest = (rows: ChatArtifact[]) => rows.reduce<ChatArtifact | null>((best, a) => (!best || time(a) >= time(best) ? a : best), null);

/**
 * The working document behind the artifact the panel was opened on: its
 * head (the newest copy, which is what is shown, downloaded and saved), the
 * change cards and counts, and decide(). The head comes from the service's
 * list when it has loaded, from a decision's answer straight after one, and
 * from the chat's newest copy of the same document before either.
 */
export function useWorkingDocument(artifact: ChatArtifact) {
  const isDocx = artifact.kind === "docx";
  const queryClient = useQueryClient();
  const { list, decide, available, workingDocumentId } = useDocumentChanges(isDocx ? artifact : null);
  const { data: threadArtifacts } = useThreadArtifacts(isDocx ? artifact.thread_id : undefined);
  const [decidedHead, setDecidedHead] = useState<ChatArtifact | null>(null);

  const head = useMemo<ChatArtifact>(() => {
    if (!isDocx) return artifact;
    const candidates = [artifact, decidedHead, ...(threadArtifacts ?? [])].filter(
      (a): a is ChatArtifact => !!a && a.kind === "docx" && workingDocumentIdOf(a) === workingDocumentId,
    );
    const summary = list.data?.head;
    if (summary) {
      const sameRow = candidates.filter((a) => a.id === summary.id);
      const samePath = sameRow.filter((a) => dataOf(a).storagePath === summary.storagePath);
      if (samePath.length) return freshest(samePath)!;
      const base = freshest(sameRow) ?? { ...artifact, id: summary.id, title: summary.title };
      return { ...base, data: { ...(base.data as object), bucket: summary.bucket, storagePath: summary.storagePath, fileName: summary.fileName ?? dataOf(base).fileName } };
    }
    if (decidedHead && workingDocumentIdOf(decidedHead) === workingDocumentId) return decidedHead;
    // Before the list: the newest copy in the chat (oldest first, so the last).
    const lineage = (threadArtifacts ?? []).filter((a) => a.kind === "docx" && workingDocumentIdOf(a) === workingDocumentId);
    const newest = lineage.at(-1);
    if (!newest) return artifact;
    return freshest(candidates.filter((a) => a.id === newest.id)) ?? newest;
  }, [isDocx, artifact, decidedHead, threadArtifacts, list.data?.head, workingDocumentId]);

  // The service names a head the chat's list has not caught up with yet.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const id = list.data?.head.id;
    if (!id || !threadArtifacts || threadArtifacts.some((a) => a.id === id) || asked.current === id) return;
    asked.current = id;
    queryClient.invalidateQueries({ queryKey: ["chat-artifacts", artifact.thread_id] });
  }, [list.data?.head.id, threadArtifacts, queryClient, artifact.thread_id]);

  const decideChanges = useCallback(
    async (decisions: Decision[]) => {
      const result = await decide.mutateAsync(decisions);
      setDecidedHead(result.head);
      return result;
    },
    [decide],
  );

  const counts: Partial<ChangeCounts> | null = list.data?.counts ?? dataOf(head).changeCounts ?? null;
  const cards: ChangeCard[] | undefined = list.data?.changes;
  return {
    isDocx,
    available,
    workingDocumentId,
    head,
    isEarlierCopy: isDocx && head.id !== artifact.id,
    counts,
    cards,
    loading: list.isLoading,
    error: list.error ? (list.error as Error).message : null,
    reload: () => list.refetch(),
    decide: decideChanges,
    deciding: decide.isPending,
  };
}

export type WorkingDocument = ReturnType<typeof useWorkingDocument>;

/** The project document a version would be added to: its title and the number the next version gets. */
export function useProjectDocumentLatest(matterDocumentId: string | null | undefined) {
  return useQuery({
    queryKey: ["project-document-latest", matterDocumentId],
    enabled: !!matterDocumentId,
    queryFn: async () => {
      const [{ data: md }, { data: latest }] = await Promise.all([
        supabase.from("matter_documents").select("*").eq("id", matterDocumentId!).maybeSingle(),
        supabase.from("document_versions").select("id, version_number").eq("matter_document_id", matterDocumentId!).order("version_number", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (!md) return null;
      const last = Math.max(Number((md as { last_version_number?: number }).last_version_number ?? 0) || 0, latest?.version_number ?? 0);
      return { title: md.title, matterId: md.matter_id, latestVersionId: latest?.id ?? null, latestVersion: last, nextVersion: last + 1 };
    },
  });
}
