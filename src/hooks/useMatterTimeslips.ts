import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MatterTimeslip {
  id: string;
  matter_id: string;
  author_id: string;
  work_date: string;
  hours: number;
  task_code: string | null;
  narrative: string;
  source: string;
  uploaded_at: string;
  author: { full_name: string | null; email: string } | null;
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
          "id, matter_id, author_id, work_date, hours, task_code, narrative, source, uploaded_at, author:profiles!matter_timeslips_author_id_fkey(full_name, email)"
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

export function authorName(slip: MatterTimeslip): string {
  return slip.author?.full_name || slip.author?.email || "Unknown";
}

/** Totals keyed by day and by author, for the two grouped views. */
export function summarise(slips: MatterTimeslip[]) {
  const byDay = new Map<string, number>();
  const byAuthor = new Map<string, number>();
  let total = 0;
  for (const s of slips) {
    const h = Number(s.hours);
    total += h;
    byDay.set(s.work_date, (byDay.get(s.work_date) ?? 0) + h);
    const who = authorName(s);
    byAuthor.set(who, (byAuthor.get(who) ?? 0) + h);
  }
  return { total, byDay, byAuthor };
}
