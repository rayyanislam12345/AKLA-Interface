import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

export type RedlineStatus = Enums<"redline_status">;

export interface RedlineSuggestion {
  id: string;
  document_version_id: string;
  clause_reference: string | null;
  original_text: string | null;
  suggested_text: string | null;
  rationale: string | null;
  status: RedlineStatus;
}

export function useLatestDocumentVersion(matterDocumentId: string | undefined) {
  return useQuery({
    queryKey: ["latest-document-version", matterDocumentId],
    enabled: !!matterDocumentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_versions")
        .select("*")
        .eq("matter_document_id", matterDocumentId!)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useRedlineSuggestions(documentVersionId: string | undefined) {
  return useQuery({
    queryKey: ["redline-suggestions", documentVersionId],
    enabled: !!documentVersionId,
    queryFn: async (): Promise<RedlineSuggestion[]> => {
      const { data, error } = await supabase
        .from("redline_suggestions")
        .select("*")
        .eq("document_version_id", documentVersionId!)
        .order("created_at");
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
      return data as { fullText: string; suggestions: RedlineSuggestion[] };
    },
    onSuccess: (_data, documentVersionId) => {
      queryClient.invalidateQueries({ queryKey: ["redline-suggestions", documentVersionId] });
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
        .eq("id", suggestionId);
      if (error) throw error;
      return documentVersionId;
    },
    onSuccess: (documentVersionId) => {
      queryClient.invalidateQueries({ queryKey: ["redline-suggestions", documentVersionId] });
    },
  });
}
