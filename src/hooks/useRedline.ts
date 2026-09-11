import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

export type RedlineStatus = Enums<"redline_status">;
export type RedlineReviewType = "legal_clauses" | "formatting" | "content_conflicts" | "chat";

export interface RedlineSuggestion {
  id: string;
  document_version_id: string;
  clause_reference: string | null;
  original_text: string | null;
  suggested_text: string | null;
  rationale: string | null;
  status: RedlineStatus;
  review_type: RedlineReviewType;
}

export function useLatestDocumentVersion(matterDocumentId: string | undefined, documentVersionId?: string) {
  return useQuery({
    queryKey: ["latest-document-version", matterDocumentId, documentVersionId],
    enabled: !!matterDocumentId,
    queryFn: async () => {
      let query = supabase
        .from("document_versions")
        .select("*")
        .eq("matter_document_id", matterDocumentId!)
      if (documentVersionId) query = query.eq("id", documentVersionId);
      const { data, error } = await query.order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useRedlineSuggestions(documentVersionId: string | undefined, reviewRunId?: string | null) {
  return useQuery({
    queryKey: ["redline-suggestions", documentVersionId, reviewRunId],
    enabled: !!documentVersionId,
    queryFn: async (): Promise<RedlineSuggestion[]> => {
      let query = supabase
        .from("redline_suggestions")
        .select("*")
        .eq("document_version_id", documentVersionId!);
      if (reviewRunId) query = query.eq("review_run_id", reviewRunId);
      else query = query.is("review_run_id", null);
      const { data, error } = await query.order("created_at");
      if (error) throw error;
      return data.map(row => {
        if (!["legal_clauses", "formatting", "content_conflicts", "chat"].includes(row.review_type)) throw new Error("Unknown review type");
        return { ...row, review_type: row.review_type as RedlineReviewType };
      });
    },
  });
}

export function useReviewRun(documentVersionId?: string, reviewRunId?: string | null) {
  return useQuery({
    queryKey: ["review-run", documentVersionId, reviewRunId], enabled: !!documentVersionId,
    queryFn: async () => {
      let query = supabase.from("ai_review_runs").select("*").eq("document_version_id", documentVersionId!);
      if (reviewRunId) query = query.eq("id", reviewRunId);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useRunRedlineReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentVersionId: string) => {
      const { data, error } = await supabase.functions.invoke("suggest-redline", {
        body: { documentVersionId },
      });
      if (error) throw error;
      return data as { fullText: string; reviewRunId: string; passes: Record<string, { status: string; note?: string }>; suggestions: RedlineSuggestion[] };
    },
    onSuccess: (_data, documentVersionId) => {
      queryClient.invalidateQueries({ queryKey: ["redline-suggestions", documentVersionId] });
      queryClient.invalidateQueries({ queryKey: ["review-run", documentVersionId] });
    },
  });
}

export function useRedlineChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentVersionId: string; threadId?: string; reviewRunId?: string; instruction: string }) => {
      const { data, error } = await supabase.functions.invoke("redline-chat", { body: input });
      if (error) throw error;
      return data as { threadId: string; reply: string; newSuggestions: RedlineSuggestion[] };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["redline-suggestions", variables.documentVersionId] });
    },
  });
}

export function useSetSuggestionStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      suggestionId,
      status,
      documentVersionId,
    }: {
      suggestionId: string;
      status: "accepted" | "rejected";
      documentVersionId: string;
    }) => {
      const { error } = await supabase
        .from("redline_suggestions")
        .update({ status })
        .eq("id", suggestionId).eq("document_version_id", documentVersionId);
      if (error) throw error;
      return documentVersionId;
    },
    onSuccess: (documentVersionId) => {
      queryClient.invalidateQueries({ queryKey: ["redline-suggestions", documentVersionId] });
    },
  });
}

export interface ApplyRedlinesResult {
  previewStoragePath: string;
  appliedCount: number;
  skippedCount: number;
  skipped: Array<{ suggestionId: string; clauseReference: string | null; reason: string }>;
}

// Applies every non-rejected suggestion as real Word tracked-changes onto a
// copy of the actual uploaded .docx, and writes it to a fixed, overwritten
// "preview" path — call after any suggestion-set change (review run,
// accept/reject, redline-chat) to keep the in-app preview in sync.
export function useApplyRedlinesPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ documentVersionId, reviewRunId }: { documentVersionId: string; reviewRunId?: string }) => {
      const { data, error } = await supabase.functions.invoke("apply-redlines-to-docx", {
        body: { documentVersionId, reviewRunId },
      });
      if (error) throw error;
      return data as ApplyRedlinesResult;
    },
    onSuccess: (_data, { documentVersionId }) => {
      queryClient.invalidateQueries({ queryKey: ["redline-preview", documentVersionId] });
    },
  });
}

// Downloads the live preview file's bytes once its storage path is known —
// separate from the mutation above so the rendered blob can be cached/
// refetched independently of whichever action last regenerated it.
export function useRedlinePreviewFile(previewStoragePath: string | undefined) {
  return useQuery({
    queryKey: ["redline-preview-file", previewStoragePath],
    enabled: !!previewStoragePath,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("matter-documents").download(previewStoragePath!);
      if (error) throw error;
      return data;
    },
  });
}
