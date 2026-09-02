import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MatterTimeslip {
  id: string;
  matter_id: string;
  author_id: string;
  work_date: string;
  hours: number;
  billable: boolean;
  task_code: string | null;
  narrative: string;
  source: string;
  uploaded_at: string;
  hub_task_id: string | null;
  author: { full_name: string | null; email: string } | null;
  task: { title: string } | null;
}

export type RangePreset = "today" | "7" | "30" | "90" | "all";

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  all: "All time",
};

/** Inclusive [from, to] as YYYY-MM-DD, or nulls for "all". */
export function resolveRange(preset: RangePreset): {
  from: string | null;
  to: string | null;
} {
  if (preset === "all") return { from: null, to: null };
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  if (preset === "today") return { from: to, to };
  const days = Number(preset);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), to };
}

export function useMatterTimeslips(
  matterId: string | undefined,
  range: { from: string | null; to: string | null }
) {
  return useQuery({
    queryKey: ["matter-timeslips", matterId, range.from, range.to],
    enabled: !!matterId,
    queryFn: async (): Promise<MatterTimeslip[]> => {
      let q = supabase
        .from("matter_timeslips")
        .select(
          "id, matter_id, author_id, work_date, hours, billable, task_code, narrative, source, uploaded_at, hub_task_id, author:profiles!matter_timeslips_author_id_fkey(full_name, email), task:matter_tasks(title)"
        )
        .eq("matter_id", matterId!)
        .order("work_date", { ascending: false })
        .order("hours", { ascending: false });
      if (range.from) q = q.gte("work_date", range.from);
      if (range.to) q = q.lte("work_date", range.to);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as MatterTimeslip[];
    },
  });
}

export interface MyTimeslip {
  id: string;
  matter_id: string;
  work_date: string;
  hours: number;
  narrative: string;
  billable_hours: number | null;
  ak_billable_hours: number | null;
  sort_order: number | null;
  matter: { name: string } | null;
}

// Same shape as useMatterTimeslips but scoped to one associate across every
// matter they've logged time against, for the self-service "Today's
// Timesheet" page — RLS already allows any firm member to read all
// timeslips, so this is purely a client-side author_id filter, not a
// separate access grant.
//
// Ordered by sort_order (the associate's own drag-to-reorder choice) with
// upload order as a fallback for rows that never got one — never re-sorted
// by anything that could shift under an edit (e.g. hours or a text field),
// which is what "the rows keep reordering themselves" was actually about.
export function useMyTimeslips(
  userId: string | undefined,
  range: { from: string | null; to: string | null }
) {
  return useQuery({
    queryKey: ["my-timeslips", userId, range.from, range.to],
    enabled: !!userId,
    queryFn: async (): Promise<MyTimeslip[]> => {
      let q = supabase
        .from("matter_timeslips")
        .select(
          "id, matter_id, work_date, hours, narrative, billable_hours, ak_billable_hours, sort_order, matter:matters(name)"
        )
        .eq("author_id", userId!)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("uploaded_at", { ascending: true });
      if (range.from) q = q.gte("work_date", range.from);
      if (range.to) q = q.lte("work_date", range.to);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as MyTimeslip[];
    },
  });
}

// Persists a full new row order in one go (drag-and-drop drop handler) —
// every visible row gets an explicit sort_order 0..n-1 so the ordering no
// longer depends on upload order at all, even for rows that never had one.
export function useReorderMyTimeslips() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orderedIds: string[]) => {
      await Promise.all(
        orderedIds.map((id, index) =>
          supabase.from("matter_timeslips").update({ sort_order: index }).eq("id", id)
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-timeslips"] });
    },
  });
}

// Every field a "Today's Timesheet" row can edit inline — matter
// reassignment included, since the page treats every column (Transaction
// through AK Billable Hours) as directly editable, not just narrative/hours.
export interface MyTimeslipEdits {
  matter_id?: string;
  narrative?: string;
  hours?: number;
  billable_hours?: number | null;
  ak_billable_hours?: number | null;
}

export function useUpdateMyTimeslip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edits }: { id: string; edits: MyTimeslipEdits }) => {
      const { error } = await supabase.from("matter_timeslips").update(edits).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-timeslips"] });
    },
  });
}

// Every field except author_id — matching who did the work isn't something
// an edit should change; it's the one thing the RLS policy still can't be
// talked out of by an admin/partner editing someone else's entry.
export interface TimeslipEdits {
  work_date: string;
  hours: number;
  task_code: string | null;
  narrative: string;
  hub_task_id: string | null;
}

export function useUpdateTimeslip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      matterId,
      edits,
    }: {
      id: string;
      matterId: string;
      edits: TimeslipEdits;
    }) => {
      const { error } = await supabase.from("matter_timeslips").update(edits).eq("id", id);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-timeslips", matterId] });
    },
  });
}

/** An hours total split by billable status — the hours themselves are never
 * hidden or filtered, just also broken out into how much of them bill. */
export interface HourSplit {
  total: number;
  billable: number;
}

function addToSplit(split: HourSplit | undefined, hours: number, billable: boolean): HourSplit {
  const base = split ?? { total: 0, billable: 0 };
  return {
    total: base.total + hours,
    billable: base.billable + (billable ? hours : 0),
  };
}

/** Totals keyed by the task the work was billed against. */
export function byTask(slips: MatterTimeslip[]) {
  const out = new Map<string, HourSplit>();
  for (const s of slips) {
    const key = s.task?.title ?? "No task";
    out.set(key, addToSplit(out.get(key), Number(s.hours), s.billable));
  }
  return out;
}

export function authorName(slip: MatterTimeslip): string {
  return slip.author?.full_name || slip.author?.email || "Unknown";
}

/** Totals keyed by day and by author, for the two grouped views — plus the
 * overall billable/non-billable split for the card's headline figures. */
export function summarise(slips: MatterTimeslip[]) {
  const byDay = new Map<string, HourSplit>();
  const byAuthor = new Map<string, HourSplit>();
  let total = 0;
  let billableTotal = 0;
  for (const s of slips) {
    const h = Number(s.hours);
    total += h;
    if (s.billable) billableTotal += h;
    byDay.set(s.work_date, addToSplit(byDay.get(s.work_date), h, s.billable));
    const who = authorName(s);
    byAuthor.set(who, addToSplit(byAuthor.get(who), h, s.billable));
  }
  return { total, billableTotal, nonBillableTotal: total - billableTotal, byDay, byAuthor };
}
