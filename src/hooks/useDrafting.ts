import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useDraftingInterview() {
  return useMutation({
    mutationFn: async (input: {
      matterId: string;
      documentTypeId: string;
      threadId?: string;
      message?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("drafting-interview", {
        body: input,
      });
      if (error) throw error;
      return data as { threadId: string; reply: string; isReadyToDraft: boolean };
    },
  });
}

export function useGenerateDraft() {
  return useMutation({
    mutationFn: async (input: {
      matterId: string;
      documentTypeId: string;
      threadId?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("draft-document", {
        body: input,
      });
      if (error) throw error;
      return data as { draft: string; precedentCount: number; hasTemplate: boolean };
    },
  });
}

// Follow-up turn on an already-generated draft — same edge function, a
// distinct hook since the response shape is genuinely different (a chat
// reply + possibly-updated draft, not a fresh generation).
export function useReviseDraft() {
  return useMutation({
    mutationFn: async (input: {
      matterId: string;
      documentTypeId: string;
      threadId?: string;
      currentDraft: string;
      instruction: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("draft-document", {
        body: input,
      });
      if (error) throw error;
      return data as { reply: string; updatedDraft: string; documentChanged: boolean };
    },
  });
}
