import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type LawUpdateType =
  | "consolidated_replacement"
  | "amending_instrument"
  | "new_act"
  | "bill"
  | "notice";

export interface LawUpdate {
  id: string;
  act_name: string | null;
  authority_ref: string | null;
  title: string;
  summary: string | null;
  update_type: string;
  source_name: string;
  source_url: string | null;
  document_url: string | null;
  published_date: string | null;
  discovered_at: string;
  library_action: string;
  library_action_note: string | null;
  confidence: string | null;
}

export interface LawUpdateDigest {
  digest_date: string;
  summary_markdown: string;
  update_count: number;
  generated_at: string;
}

// The newsletter itself — one row per day, written by the law-monitor job on
// the VM. The most recent one is shown rather than strictly today's, so a
// morning where the VM was down still leaves yesterday's briefing on screen
// (with its date visible) instead of an empty card.
export function useLatestLawDigest() {
  return useQuery({
    queryKey: ["law-update-digest"],
    queryFn: async (): Promise<LawUpdateDigest | null> => {
      const { data, error } = await supabase
        .from("law_update_digests")
        .select("digest_date, summary_markdown, update_count, generated_at")
        .order("digest_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useRecentLawUpdates(limit = 12) {
  return useQuery({
    queryKey: ["law-updates", limit],
    queryFn: async (): Promise<LawUpdate[]> => {
      const { data, error } = await supabase
        .from("law_updates")
        .select("*")
        .order("discovered_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data as LawUpdate[];
    },
  });
}

export function useLawUpdate(updateId: string | undefined) {
  return useQuery({
    queryKey: ["law-update", updateId],
    enabled: !!updateId,
    queryFn: async (): Promise<LawUpdate | null> => {
      const { data, error } = await supabase
        .from("law_updates")
        .select("*")
        .eq("id", updateId!)
        .maybeSingle();
      if (error) throw error;
      return data as LawUpdate | null;
    },
  });
}

// Developments affecting the Acts this matter actually depends on, minus the
// ones someone here has already dealt with. Bills are deliberately excluded:
// a proposed law hasn't changed anything yet, so flagging a matter amber for
// one would be crying wolf. They still appear in the daily newsletter.
export function useMatterLawUpdates(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-law-updates", matterId],
    enabled: !!matterId,
    queryFn: async (): Promise<LawUpdate[]> => {
      const { data: laws, error: lawsError } = await supabase
        .from("matter_relevant_laws")
        .select("act_name")
        .eq("matter_id", matterId!);
      if (lawsError) throw lawsError;

      const actNames = (laws ?? []).map((l) => l.act_name).filter(Boolean) as string[];
      if (actNames.length === 0) return [];

      const [updatesResult, acksResult] = await Promise.all([
        supabase
          .from("law_updates")
          .select("*")
          .in("act_name", actNames)
          .neq("update_type", "bill")
          .order("discovered_at", { ascending: false }),
        supabase.from("matter_law_update_acks").select("law_update_id").eq("matter_id", matterId!),
      ]);
      if (updatesResult.error) throw updatesResult.error;
      if (acksResult.error) throw acksResult.error;

      const acknowledged = new Set((acksResult.data ?? []).map((a) => a.law_update_id));
      return ((updatesResult.data ?? []) as LawUpdate[]).filter((u) => !acknowledged.has(u.id));
    },
  });
}

// Clears the amber flag on one matter only — the same development stays
// flagged on every other matter that depends on that Act.
export function useAcknowledgeLawUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, lawUpdateId }: { matterId: string; lawUpdateId: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("matter_law_update_acks").insert({
        matter_id: matterId,
        law_update_id: lawUpdateId,
        acknowledged_by: userData.user?.id,
      });
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-law-updates", matterId] });
    },
  });
}

export interface DocumentCitingAct {
  matter_document_id: string;
  title: string;
  mentions: number;
}

// Which of the matter's documents actually cite the Act, so "Revise" can name
// them instead of making the associate guess which file is affected.
export function useDocumentsCitingAct(matterId: string | undefined, actName: string | null | undefined) {
  return useQuery({
    queryKey: ["documents-citing-act", matterId, actName],
    enabled: !!matterId && !!actName,
    queryFn: async (): Promise<DocumentCitingAct[]> => {
      const { data, error } = await supabase.rpc("matter_documents_citing_act", {
        p_matter_id: matterId!,
        p_act_name: actName!,
      });
      if (error) throw error;
      return (data ?? []) as DocumentCitingAct[];
    },
  });
}

export function lawUpdateTypeLabel(type: string) {
  switch (type) {
    case "consolidated_replacement":
      return "Consolidated re-issue";
    case "amending_instrument":
      return "Amendment";
    case "new_act":
      return "New Act";
    case "bill":
      return "Bill (not yet law)";
    case "notice":
      return "Notice";
    default:
      return type;
  }
}

// The instruction that lands in the review box when an associate clicks
// Revise. Pre-filled rather than auto-sent, so they can read it, adjust the
// emphasis, and decide — the AI review runs when they press send.
export function buildRevisePrompt(update: LawUpdate, documentTitle?: string) {
  const act = update.act_name ?? "a law this matter relies on";
  const ref = update.authority_ref ? ` (${update.authority_ref})` : "";
  const published = update.published_date ? `, published ${update.published_date}` : "";
  const source = update.document_url || update.source_url;

  return [
    `${act} has been affected by: ${update.title}${ref}${published} — ${lawUpdateTypeLabel(update.update_type)} via ${update.source_name}.`,
    update.summary ? `What changed: ${update.summary}` : null,
    source ? `Source: ${source}` : null,
    "",
    `Review ${documentTitle ? `"${documentTitle}"` : "this document"} against that change. Identify every clause that relies on, cites, or is shaped by ${act}, and flag anything now inconsistent, outdated, or missing as a result. Propose specific redline changes with the exact replacement wording.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}
