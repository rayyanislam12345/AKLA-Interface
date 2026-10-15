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
  lead_partner_id: string | null;
  client: { name: string } | null;
  lead_partner: { full_name: string | null } | null;
}

// A project's status used to be free text. It is now one of three fixed
// values. Anything already stored is read case-insensitively ("Active ",
// "on hold", "On-Hold"); a value that is none of the three reads as Active
// until someone edits the project, so no project disappears from view.
export const MATTER_STATUSES = ["active", "on_hold", "closed"] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export const MATTER_STATUS_LABELS: Record<MatterStatus, string> = {
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
};

export function normalizeMatterStatus(raw: string | null | undefined): MatterStatus {
  const s = (raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "onhold") return "on_hold";
  if (s === "closed") return "closed";
  return "active";
}

export function matterStatusLabel(raw: string | null | undefined) {
  return MATTER_STATUS_LABELS[normalizeMatterStatus(raw)];
}

export function matterStatusBadgeVariant(raw: string | null | undefined): "default" | "secondary" | "outline" {
  const s = normalizeMatterStatus(raw);
  return s === "active" ? "default" : s === "on_hold" ? "secondary" : "outline";
}

export function isOpenMatter(m: { status: string | null }) {
  return normalizeMatterStatus(m.status) !== "closed";
}

const openMattersOnly = (rows: MatterListItem[]) => rows.filter(isOpenMatter);

/**
 * Every project the user can see, closed ones included, so a lookup of an
 * existing link (a timeslip's project, a linked WhatsApp project) still finds
 * a project after it is closed. A list someone picks a project from should
 * pass { openOnly: true } to offer only Active and On hold projects.
 */
export function useMatters(options: { openOnly?: boolean } = {}) {
  const openOnly = options.openOnly ?? false;
  return useQuery({
    queryKey: ["matters"],
    queryFn: async (): Promise<MatterListItem[]> => {
      const { data, error } = await supabase
        .from("matters")
        .select(
          "id, name, client_id, sector, matter_type, status, opened_date, target_close_date, lead_partner_id, client:clients(name), lead_partner:profiles!matters_lead_partner_id_fkey(full_name)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as MatterListItem[];
    },
    select: openOnly ? openMattersOnly : undefined,
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
        // maybeSingle, not single: a project that has been deleted (or that
        // this user can't see) is a normal outcome, and single() turns it
        // into a 406 that React Query then retries three more times. null
        // lets the page say so instead of spinning.
        .maybeSingle();
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

export function useUpdateMatter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      name: string;
      client_id?: string;
      sector?: string;
      lead_partner_id?: string;
      status: MatterStatus;
      target_close_date?: string | null;
    }) => {
      const { error } = await supabase
        .from("matters")
        .update({
          name: input.name,
          client_id: input.client_id || null,
          sector: input.sector || null,
          lead_partner_id: input.lead_partner_id || null,
          status: input.status,
          target_close_date: input.target_close_date || null,
        })
        .eq("id", input.id);
      if (error) throw error;
      return input.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["matters"] });
      queryClient.invalidateQueries({ queryKey: ["matter", id] });
    },
  });
}

// Close / Reopen / put on hold from the project's own page, without opening
// the edit form. Row-level security already lets every firm member update a
// project, so this is open to everyone.
export function useSetMatterStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: MatterStatus }) => {
      const { error } = await supabase.from("matters").update({ status }).eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["matters"] });
      queryClient.invalidateQueries({ queryKey: ["matter", id] });
    },
  });
}

// Every table under a matter (matter_documents, document_versions,
// redline_suggestions, ai_chat_threads/messages, matter_context,
// matter_relevant_laws, matter_stages/parties/notes/tasks, and the matter's
// RAG chunks in `documents`) cascades via ON DELETE CASCADE at the DB level
// — a plain delete on `matters` removes all of it. whatsapp_matters is the
// one exception, deliberately ON DELETE SET NULL: that's synced WhatsApp
// bot data the firm doesn't own, so deleting a matter just unlinks it
// rather than destroying it. The one thing FK cascades can't reach is
// Storage — matter-documents bucket objects are collected before the
// delete (their DB rows are about to disappear) and removed after,
// best-effort, since a few orphaned files aren't worth failing the delete
// itself over.
export function useDeleteMatter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (matterId: string) => {
      const { data: matterDocs } = await supabase
        .from("matter_documents")
        .select("id")
        .eq("matter_id", matterId);

      let storagePaths: string[] = [];
      if (matterDocs && matterDocs.length > 0) {
        const { data: versions } = await supabase
          .from("document_versions")
          .select("storage_path")
          .in("matter_document_id", matterDocs.map((d) => d.id));
        storagePaths = (versions ?? []).map((v) => v.storage_path);
      }

      const { error } = await supabase.from("matters").delete().eq("id", matterId);
      if (error) throw error;

      if (storagePaths.length > 0) {
        const { error: storageError } = await supabase.storage.from("matter-documents").remove(storagePaths);
        if (storageError) console.error("Project deleted but some storage files could not be removed:", storageError);
      }
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
