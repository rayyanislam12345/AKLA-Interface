import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useMatterParties(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-parties", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_parties")
        .select("*")
        .eq("matter_id", matterId!)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function useAddMatterParty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matter_id: string; name: string; role: string }) => {
      const { error } = await supabase.from("matter_parties").insert(input);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-parties", variables.matter_id] });
    },
  });
}

export function useMatterTasks(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-tasks", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_tasks")
        .select("*, assignee:profiles(full_name)")
        .eq("matter_id", matterId!)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function useAddMatterTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matter_id: string; title: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("matter_tasks")
        .insert({ ...input, created_by: userData.user?.id });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-tasks", variables.matter_id] });
    },
  });
}

export function useToggleTaskStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      status,
      matterId,
    }: {
      taskId: string;
      status: "open" | "in_progress" | "done";
      matterId: string;
    }) => {
      const { error } = await supabase.from("matter_tasks").update({ status }).eq("id", taskId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-tasks", matterId] });
    },
  });
}

export function useDeleteMatterTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, matterId }: { taskId: string; matterId: string }) => {
      const { error } = await supabase.from("matter_tasks").delete().eq("id", taskId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-tasks", matterId] });
    },
  });
}

export function useMatterNotes(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-notes", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_notes")
        .select("*, author:profiles(full_name)")
        .eq("matter_id", matterId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useAddMatterNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matter_id: string; content: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("matter_notes")
        .insert({ ...input, author_id: userData.user?.id });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-notes", variables.matter_id] });
    },
  });
}
