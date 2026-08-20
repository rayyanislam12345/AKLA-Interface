import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export function useMatterChatThread(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-chat-thread", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_chat_threads")
        .select("id")
        .eq("matter_id", matterId!)
        .eq("title", "Matter Q&A")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useMatterChatMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: ["matter-chat-messages", threadId],
    enabled: !!threadId,
    queryFn: async (): Promise<ChatMessage[]> => {
      const { data, error } = await supabase
        .from("ai_chat_messages")
        .select("id, role, content, created_at")
        .eq("thread_id", threadId!)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function useAskMatterQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matterId: string; threadId?: string; query: string }) => {
      const { data, error } = await supabase.functions.invoke("rag-query", {
        body: {
          query: input.query,
          matterId: input.matterId,
          threadId: input.threadId,
        },
      });
      if (error) throw error;
      return data as { threadId: string; answer: string; sources: any[] };
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-chat-messages", data.threadId] });
      queryClient.invalidateQueries({ queryKey: ["matter-chat-thread", variables.matterId] });
    },
  });
}
