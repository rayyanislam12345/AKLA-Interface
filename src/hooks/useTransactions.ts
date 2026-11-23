import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import type { Json, Tables } from "@/integrations/supabase/types";
import {
  DEFAULT_STALE_AFTER_DAYS,
  changeLine,
  changeLines,
  readTrayItem,
  type UpdateSource,
} from "@/lib/transactions";

// The newest line rides along with each row so the table can stamp it with
// its author and source without a second query.
export type TransactionRow = Tables<"transaction_rows"> & {
  latest?: { author: string | null; source: string; at: string }[];
};
export type TransactionUpdate = Tables<"transaction_updates">;
export type TrayItem = Tables<"intake_tray">;
export type TimeSuggestion = Tables<"transaction_time_suggestions">;

const ROWS_KEY = ["transaction-rows"];
const UPDATES_KEY = ["transaction-updates"];
const TRAY_KEY = ["intake-tray"];
const TRAY_COUNT_KEY = ["intake-tray-count"];
const SUGGESTIONS_KEY = ["time-suggestions"];

/** Every live row of the sheet, closed ones included, in the sheet's order. */
export function useTransactionRows() {
  return useQuery({
    queryKey: ROWS_KEY,
    queryFn: async (): Promise<TransactionRow[]> => {
      const { data, error } = await supabase
        .from("transaction_rows")
        .select("*, latest:transaction_updates(author, source, at)")
        .is("archived_at", null)
        .order("sort_order")
        .order("at", { referencedTable: "transaction_updates", ascending: false })
        .limit(1, { referencedTable: "transaction_updates" });
      if (error) throw error;
      return (data ?? []) as unknown as TransactionRow[];
    },
  });
}

export function useTransactionUpdates(rowId: string | null | undefined) {
  return useQuery({
    queryKey: [...UPDATES_KEY, rowId],
    enabled: !!rowId,
    queryFn: async (): Promise<TransactionUpdate[]> => {
      const { data, error } = await supabase
        .from("transaction_updates")
        .select("*")
        .eq("row_id", rowId!)
        .order("at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** The updates of several rows at once (a project's, a person's), newest first, each with its row's name. */
export type TimelineUpdate = TransactionUpdate & { row?: { deliverable: string; client: string; project: string } | null };
export function useTransactionTimeline(rowIds: string[], enabled = true) {
  const key = [...rowIds].sort().join(",");
  return useQuery({
    queryKey: [...UPDATES_KEY, "timeline", key],
    enabled: enabled && rowIds.length > 0,
    queryFn: async (): Promise<TimelineUpdate[]> => {
      const { data, error } = await supabase
        .from("transaction_updates")
        .select("*, row:transaction_rows(deliverable, client, project)")
        .in("row_id", rowIds)
        .order("at", { ascending: false })
        .limit(600);
      if (error) throw error;
      return (data ?? []) as unknown as TimelineUpdate[];
    },
  });
}

/** intake_settings.stale_after_days, or the firm's default when unset or unreadable. */
export function useStaleAfterDays() {
  return useQuery({
    queryKey: ["intake-settings", "stale_after_days"],
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.from("intake_settings").select("value").eq("key", "stale_after_days").maybeSingle();
      if (error) throw error;
      const n = Number(data?.value);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_AFTER_DAYS;
    },
  });
}

export function useTrayCount() {
  return useQuery({
    queryKey: TRAY_COUNT_KEY,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase.from("intake_tray").select("id", { count: "exact", head: true }).eq("status", "open");
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/** Open tray items, oldest first: the one waiting longest is dealt with first. */
export function useOpenTray() {
  return useQuery({
    queryKey: TRAY_KEY,
    queryFn: async (): Promise<TrayItem[]> => {
      const { data, error } = await supabase.from("intake_tray").select("*").eq("status", "open").order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMyTimeSuggestions(userId: string | undefined) {
  return useQuery({
    queryKey: [...SUGGESTIONS_KEY, userId],
    enabled: !!userId,
    queryFn: async (): Promise<TimeSuggestion[]> => {
      const { data, error } = await supabase
        .from("transaction_time_suggestions")
        .select("*")
        .eq("person_id", userId!)
        .eq("status", "open")
        .order("work_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Who is making the change, as the sheet stamps it: the full name, or the
// email when the profile has none yet.
export function useActor() {
  const { user } = useAuth();
  const { data: me } = useMyProfile();
  return { id: user?.id ?? null, name: me?.full_name || user?.email || null };
}

export function useInvalidateSheet() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ROWS_KEY });
    qc.invalidateQueries({ queryKey: UPDATES_KEY });
    qc.invalidateQueries({ queryKey: TRAY_KEY });
    qc.invalidateQueries({ queryKey: TRAY_COUNT_KEY });
  };
}

export interface UpdateLine {
  rowId: string;
  body: string;
  source?: UpdateSource;
  sourceRef?: string | null;
  author?: string | null;
  authorId?: string | null;
  at?: string;
}

export async function insertUpdate(line: UpdateLine, actor: { id: string | null; name: string | null }) {
  const { error } = await supabase.from("transaction_updates").insert({
    row_id: line.rowId,
    body: line.body,
    source: line.source ?? "hub",
    source_ref: line.sourceRef ?? null,
    author: line.author === undefined ? actor.name : line.author,
    author_id: line.authorId === undefined ? actor.id : line.authorId,
    at: line.at ?? new Date().toISOString(),
  });
  if (error) throw error;
}

/** The sheet's next Sr. No. */
async function nextSortOrder(): Promise<number> {
  const { data, error } = await supabase.from("transaction_rows").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  if (error) throw error;
  return (data?.[0]?.sort_order ?? 0) + 1;
}

export interface NewTransactionRow {
  client: string;
  project: string;
  deliverable: string;
  team: string[];
  status?: string;
  currently_with?: string | null;
  updated_source?: UpdateSource;
}

async function insertRow(input: NewTransactionRow, actorId: string | null): Promise<TransactionRow> {
  const { data, error } = await supabase
    .from("transaction_rows")
    .insert({
      sort_order: await nextSortOrder(),
      client: input.client.trim(),
      project: input.project.trim(),
      deliverable: input.deliverable.trim(),
      team: input.team.map((t) => t.trim()).filter(Boolean),
      status: input.status ?? "Not Started",
      currently_with: input.currently_with ?? null,
      updated_source: input.updated_source ?? "hub",
      updated_by: actorId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** A person's own line on a row; the trigger makes it the row's latest update. */
export function useAddTransactionUpdate() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: async ({ rowId, body }: { rowId: string; body: string }) => {
      await insertUpdate({ rowId, body: body.trim() }, actor);
    },
    onSuccess: invalidate,
  });
}

export type RowEdits = Partial<Pick<TransactionRow, "status" | "currently_with" | "team" | "deliverable" | "client" | "project">>;

/**
 * A field edit on the Hub also leaves a line in the comments, so the Excel
 * shows the move as it would had someone typed it there.
 */
export function useEditTransactionRow() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: async ({ row, edits }: { row: TransactionRow; edits: RowEdits }) => {
      const line = changeLines(row as unknown as Record<string, unknown>, edits as Record<string, unknown>);
      if (!line) return;
      const { error } = await supabase
        .from("transaction_rows")
        .update({ ...edits, updated_source: "hub", updated_by: actor.id })
        .eq("id", row.id);
      if (error) throw error;
      await insertUpdate({ rowId: row.id, body: line }, actor);
    },
    onSuccess: invalidate,
  });
}

export function useCreateTransactionRow() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: (input: NewTransactionRow) => insertRow(input, actor.id),
    onSuccess: invalidate,
  });
}

export async function resolveTray(id: string, status: "accepted" | "dropped", resolution: Json | null, actorId: string | null) {
  const { error } = await supabase
    .from("intake_tray")
    .update({ status, resolution, resolved_by: actorId, resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * A name a person confirmed in Needs a look, kept on the project. The answer
 * itself is already saved by the time this runs, so a name that is already
 * there (or one that could not be kept) never undoes it.
 */
export async function learnProjectName(matterId: string, name: string, actorId: string | null): Promise<void> {
  const clean = name.trim();
  if (!matterId || !clean) return;
  const { error } = await supabase
    .from("project_names")
    .insert({ matter_id: matterId, name: clean, kind: "learned", source: "tray", created_by: actorId });
  if (error && error.code !== "23505") console.warn("The name could not be kept on the project:", error.message);
}

export function useDropTrayItem() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: (item: TrayItem) => resolveTray(item.id, "dropped", null, actor.id),
    onSuccess: invalidate,
  });
}

/**
 * An agenda line (or a timesheet line) placed on a row: the chosen row, or a
 * new one from the intake's draft. The line it carries goes on the row in the
 * person's own name, marked as from the agenda.
 */
export function useAcceptAgendaLine() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: async ({ item, rowId }: { item: TrayItem; rowId?: string }) => {
      const v = readTrayItem(item);
      let targetId = rowId;
      let created = false;
      if (!targetId) {
        const draft = v.guessNewRow;
        if (!draft) throw new Error("There is no drafted row to add. Pick a row instead.");
        const row = await insertRow(
          {
            client: draft.client || "Unknown client",
            project: draft.project || v.transaction || "Unknown project",
            deliverable: draft.deliverable || v.deliverable || "Deliverable",
            team: draft.team.length ? draft.team : v.person ? [v.person] : [],
            status: "In Progress",
            updated_source: "agenda",
          },
          actor.id,
        );
        targetId = row.id;
        created = true;
      }
      const body = v.scope || [v.transaction, v.deliverable].filter(Boolean).join(" / ") || "Line from the daily agenda";
      await insertUpdate(
        { rowId: targetId, body, source: "agenda", sourceRef: v.file || null, author: v.person || actor.name, authorId: v.personId ?? actor.id },
        actor,
      );
      await resolveTray(item.id, "accepted", created ? { created_row_id: targetId } : { row_id: targetId }, actor.id);
      // The agenda used a name the Hub did not know and a person has now said
      // which project it is: keep the name, so it is never asked about again.
      if (!created && v.transactionKnown === false && v.transaction) {
        const { data: row } = await supabase.from("transaction_rows").select("matter_id").eq("id", targetId).maybeSingle();
        if (row?.matter_id) await learnProjectName(row.matter_id, v.transaction, actor.id);
      }
    },
    onSuccess: invalidate,
  });
}

/** A cell both sides changed: keep the Hub's, or take the sheet's into the row. */
export function useResolveExcelConflict() {
  const actor = useActor();
  const invalidate = useInvalidateSheet();
  return useMutation({
    mutationFn: async ({ item, keep }: { item: TrayItem; keep: "hub" | "excel" }) => {
      const v = readTrayItem(item);
      if (keep === "excel") {
        if (!v.rowId) throw new Error("The tray item names no row, so the sheet's value has nowhere to go.");
        const field = v.field.toLowerCase().replace(/\s+/g, "_");
        if (field === "comments" || field === "latest_update") {
          await insertUpdate({ rowId: v.rowId, body: v.sheetValue, source: "excel", author: null, authorId: null }, actor);
        } else {
          const value: unknown = field === "team" ? v.sheetValue.split(/[,;/]/).map((s) => s.trim()).filter(Boolean) : v.sheetValue;
          const { error } = await supabase
            .from("transaction_rows")
            .update({ [field]: value, updated_source: "excel", updated_by: actor.id })
            .eq("id", v.rowId);
          if (error) throw error;
          await insertUpdate({ rowId: v.rowId, body: changeLine(field, v.hubValue, v.sheetValue), source: "excel" }, actor);
        }
      }
      await resolveTray(item.id, "accepted", { kept: keep }, actor.id);
    },
    onSuccess: invalidate,
  });
}

function useInvalidateSuggestions() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: SUGGESTIONS_KEY });
    qc.invalidateQueries({ queryKey: ["my-timeslips"] });
    qc.invalidateQueries({ queryKey: ["matter-timeslips"] });
  };
}

async function confirmSuggestion(s: TimeSuggestion, userId: string): Promise<{ recorded: boolean }> {
  let timeslipId: string | null = null;
  if (s.matter_id) {
    const billableHours = s.billable_hours === null ? null : Number(s.billable_hours);
    const { data, error } = await supabase
      .from("matter_timeslips")
      .insert({
        matter_id: s.matter_id,
        author_id: userId,
        work_date: s.work_date,
        hours: Number(s.hours),
        billable: billableHours === null || billableHours > 0,
        billable_hours: billableHours,
        narrative: s.narrative,
        source: "agenda",
        external_id: s.source_ref,
      })
      .select("id")
      .single();
    if (error) throw error;
    timeslipId = data.id;
  }
  const { error } = await supabase
    .from("transaction_time_suggestions")
    .update({ status: "confirmed", timeslip_id: timeslipId, resolved_at: new Date().toISOString() })
    .eq("id", s.id);
  if (error) throw error;
  return { recorded: !!timeslipId };
}

/** The person's own hours from an agenda become a timeslip, when the row has a Hub project. */
export function useConfirmTimeSuggestions() {
  const { user } = useAuth();
  const invalidate = useInvalidateSuggestions();
  return useMutation({
    mutationFn: async (suggestions: TimeSuggestion[]) => {
      if (!user?.id) throw new Error("Sign in again to confirm your hours.");
      let recorded = 0;
      for (const s of suggestions) {
        if ((await confirmSuggestion(s, user.id)).recorded) recorded += 1;
      }
      return { recorded, kept: suggestions.length - recorded };
    },
    onSuccess: invalidate,
  });
}

export function useDropTimeSuggestion() {
  const invalidate = useInvalidateSuggestions();
  return useMutation({
    mutationFn: async (s: TimeSuggestion) => {
      const { error } = await supabase
        .from("transaction_time_suggestions")
        .update({ status: "dropped", resolved_at: new Date().toISOString() })
        .eq("id", s.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
