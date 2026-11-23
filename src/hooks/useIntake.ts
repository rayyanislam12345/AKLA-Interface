import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { toast } from "@/hooks/use-toast";
import { useCreateClient } from "@/hooks/useClients";
import { useCreateMatter } from "@/hooks/useMatters";
import { insertUpdate, resolveTray, useActor, useInvalidateSheet, type TrayItem } from "@/hooks/useTransactions";
import { friendlyError } from "@/lib/friendlyError";
import { countArrivals, exactInstant, karachiDayStartIso, nameKey, personName, readAction, type IntakeAction } from "@/lib/intake";
import { readTrayItem } from "@/lib/transactions";

// What the Hub did on its own (documents filed, lines added to rows, notes
// kept), the one-click undo for each, the names a project goes by, and the
// answers to the Needs-a-look questions about documents, projects and emails.

export type ProjectName = Tables<"project_names">;

const ACTIONS_KEY = ["intake-actions"];
const ARRIVED_TODAY_KEY = ["intake-arrived-today"];
const NAMES_KEY = ["project-names"];
const DAY_MS = 86_400_000;

interface ActionsQuery {
  /** Only what arrived on this project. */
  matterId?: string;
  /** Only the last so many days. */
  sinceDays?: number;
  limit?: number;
  enabled?: boolean;
}

/** What arrived, newest first, each with its project's name and its row's deliverable. */
export function useIntakeActions({ matterId, sinceDays, limit = 300, enabled = true }: ActionsQuery = {}) {
  return useQuery({
    queryKey: [...ACTIONS_KEY, matterId ?? "all", sinceDays ?? "any", limit],
    enabled,
    queryFn: async (): Promise<IntakeAction[]> => {
      let query = supabase
        .from("intake_actions")
        .select("*, matter:matters(name), row:transaction_rows(deliverable)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (matterId) query = query.eq("matter_id", matterId);
      if (sinceDays) query = query.gte("created_at", new Date(Date.now() - sinceDays * DAY_MS).toISOString());
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(readAction);
    },
  });
}

/** How many separate things arrived today (Karachi's today); a filing and its row line count once. */
export function useArrivedTodayCount() {
  return useQuery({
    queryKey: ARRIVED_TODAY_KEY,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.from("intake_actions").select("id, group_id").gte("created_at", karachiDayStartIso()).limit(1000);
      if (error) throw error;
      return countArrivals((data ?? []).map((r) => ({ id: r.id, groupId: r.group_id })));
    },
  });
}

/**
 * Takes back one thing the Hub did. The database does the work and refuses
 * in its own plain sentence when it should not be undone from here (a later
 * version sits on top, someone has already worked on the version); that
 * sentence is what the person is shown.
 */
export function useUndoIntakeAction() {
  const qc = useQueryClient();
  const invalidateSheet = useInvalidateSheet();
  return useMutation({
    mutationFn: async (action: Pick<IntakeAction, "id" | "kind">) => {
      const { error } = await supabase.rpc("undo_intake_action", { p_action_id: action.id });
      if (error) throw error;
      return action;
    },
    onSuccess: (action) => {
      if (action.kind === "version_filed") {
        toast({ title: "Undone", description: "The file is in Needs a look, to place again or drop." });
      }
    },
    onError: (e) => {
      toast({ title: "Couldn't undo that", description: friendlyError(e), variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ACTIONS_KEY });
      qc.invalidateQueries({ queryKey: ARRIVED_TODAY_KEY });
      qc.invalidateQueries({ queryKey: ["matter-documents"] });
      qc.invalidateQueries({ queryKey: ["matter-notes"] });
      qc.invalidateQueries({ queryKey: ["project-search"] });
      invalidateSheet();
    },
  });
}

// ---- the names a project goes by

export function useProjectNames(matterId: string | undefined) {
  return useQuery({
    queryKey: [...NAMES_KEY, matterId],
    enabled: !!matterId,
    queryFn: async (): Promise<ProjectName[]> => {
      const { data, error } = await supabase.from("project_names").select("*").eq("matter_id", matterId!).order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** True when the name was added; false when the project already had it. */
async function insertProjectName(
  input: { matterId: string; name: string; kind: "alias" | "learned"; source: "hub" | "tray" },
  actorId: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from("project_names")
    .insert({ matter_id: input.matterId, name: input.name.trim(), kind: input.kind, source: input.source, created_by: actorId });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

/** Another name people use for the project, typed on its page. */
export function useAddProjectName() {
  const actor = useActor();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, name }: { matterId: string; name: string }) => {
      const added = await insertProjectName({ matterId, name, kind: "alias", source: "hub" }, actor.id);
      if (!added) throw new Error("The project already goes by that name.");
    },
    onSuccess: (_data, { matterId }) => qc.invalidateQueries({ queryKey: [...NAMES_KEY, matterId] }),
  });
}

export function useRemoveProjectName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; matterId: string }) => {
      const { error } = await supabase.from("project_names").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_data, { matterId }) => qc.invalidateQueries({ queryKey: [...NAMES_KEY, matterId] }),
  });
}

// ---- Needs a look: documents, proposed projects, emails

export type DocumentAnswer = { matter_id: string } | { matter_id: string; document_id: string } | { matter_id: string; new_document: true };

/**
 * Where a document goes. Only the answer is recorded here; the Hub files the
 * document itself within a few minutes and notes that on the answer.
 */
export function useAnswerTrayDocument() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: ({ item, answer }: { item: TrayItem; answer: DocumentAnswer }) => resolveTray(item.id, "accepted", answer, actor.id),
    onSuccess: invalidate,
  });
}

/** The name an item was seen under: a proposed project's own, or the transaction a document was filed against. */
function seenName(item: TrayItem): string {
  const v = readTrayItem(item);
  return item.kind === "new_project" ? v.name : v.transaction;
}

/**
 * "Create the project": the client (found by name, or added), the project
 * with its code and the six stages, and the name it was seen under when that
 * is not the project's own name. The item is then answered with the project.
 */
export function useCreateProjectFromTray() {
  const actor = useActor();
  const createClient = useCreateClient();
  const createMatter = useCreateMatter();
  const invalidate = useInvalidateSheet();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, name, client, code }: { item: TrayItem; name: string; client: string; code: string }) => {
      const projectName = name.trim();
      if (!projectName) throw new Error("Give the project a name.");
      let clientId: string | undefined;
      const typed = client.trim();
      if (typed) {
        const { data: clients, error } = await supabase.from("clients").select("id, name");
        if (error) throw error;
        clientId = (clients ?? []).find((c) => c.name.trim().toLowerCase() === typed.toLowerCase())?.id;
        if (!clientId) clientId = (await createClient.mutateAsync({ name: typed })).id;
      }
      const matter = await createMatter.mutateAsync({ name: projectName, client_id: clientId, code: code.trim() || undefined });
      try {
        const seen = seenName(item);
        if (seen && nameKey(seen) !== nameKey(projectName)) {
          await insertProjectName({ matterId: matter.id, name: seen, kind: "learned", source: "tray" }, actor.id);
        }
        await resolveTray(item.id, "accepted", { matter_id: matter.id }, actor.id);
      } catch {
        // The project exists now; pressing Create again would make a second one.
        throw new Error(`${projectName} was created, but this question could not be closed. Pick it from the list of projects instead of creating it again.`);
      }
      return matter;
    },
    onSettled: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: NAMES_KEY });
    },
  });
}

/** "It's this project": the name it was seen under is kept on the project, and the item answered with it. */
export function useNameProjectFromTray() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, matterId }: { item: TrayItem; matterId: string }) => {
      const seen = seenName(item);
      if (seen) await insertProjectName({ matterId, name: seen, kind: "learned", source: "tray" }, actor.id);
      await resolveTray(item.id, "accepted", { matter_id: matterId }, actor.id);
    },
    onSuccess: (_data, { matterId }) => {
      invalidate();
      qc.invalidateQueries({ queryKey: [...NAMES_KEY, matterId] });
    },
  });
}

/**
 * An email placed on a row: what it asks (or its gist) becomes a line on the
 * row in the sender's name, dated when the email was sent and marked as from
 * email.
 */
export function useAcceptMessageLine() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: async ({ item, rowId }: { item: TrayItem; rowId: string }) => {
      const v = readTrayItem(item);
      const who = personName(v.person);
      const body = v.ask || v.scope || [v.transaction, v.deliverable].filter(Boolean).join(" / ") || "Line from an email";
      await insertUpdate(
        { rowId, body, source: "email", sourceRef: v.messageRef || null, author: who || null, authorId: null, at: exactInstant(v.date) || undefined },
        actor,
      );
      await resolveTray(item.id, "accepted", { row_id: rowId }, actor.id);
    },
    onSuccess: invalidate,
  });
}
