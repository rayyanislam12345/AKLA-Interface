import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_MATTER_STAGES = [
  "Origination",
  "Due Diligence",
  "Drafting",
  "Negotiation",
  "Financial Close",
  "Post-Closing",
];

export interface MatterListItem {
  id: string;
  name: string;
  client_id: string | null;
  sector: string | null;
  matter_type: string | null;
  status: string;
  opened_date: string;
  target_close_date: string | null;
  client: { name: string } | null;
  lead_partner: { full_name: string | null } | null;
}

export function useMatters() {
  return useQuery({
    queryKey: ["matters"],
    queryFn: async (): Promise<MatterListItem[]> => {
      const { data, error } = await supabase
        .from("matters")
        .select(
          "id, name, client_id, sector, matter_type, status, opened_date, target_close_date, client:clients(name), lead_partner:profiles!matters_lead_partner_id_fkey(full_name)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as MatterListItem[];
    },
  });
}

export function useMatter(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matters")
        .select(
          "*, client:clients(id, name), lead_partner:profiles!matters_lead_partner_id_fkey(id, full_name)"
        )
        .eq("id", matterId!)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateMatter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      client_id?: string;
      sector?: string;
      matter_type?: string;
      lead_partner_id?: string;
      target_close_date?: string;
      description?: string;
    }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { data: matter, error } = await supabase
        .from("matters")
        .insert({
          name: input.name,
          client_id: input.client_id || null,
          sector: input.sector || null,
          matter_type: input.matter_type || null,
          lead_partner_id: input.lead_partner_id || null,
          target_close_date: input.target_close_date || null,
          description: input.description || null,
          created_by: userData.user?.id,
        })
        .select()
        .single();
      if (error) throw error;

      const { error: stagesError } = await supabase.from("matter_stages").insert(
        DEFAULT_MATTER_STAGES.map((name, index) => ({
          matter_id: matter.id,
          name,
          sort_order: index,
          status: index === 0 ? "in_progress" : "not_started",
        }))
      );
      if (stagesError) throw stagesError;

      return matter;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["matters"] });
    },
  });
}

export function useMatterStages(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-stages", matterId],
    enabled: !!matterId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_stages")
        .select("*")
        .eq("matter_id", matterId!)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });
}

export function useSetStageStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      stageId,
      status,
      matterId,
    }: {
      stageId: string;
      status: "not_started" | "in_progress" | "complete";
      matterId: string;
    }) => {
      const { error } = await supabase
        .from("matter_stages")
        .update({ status, completed_at: status === "complete" ? new Date().toISOString() : null })
        .eq("id", stageId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-stages", matterId] });
    },
  });
}
