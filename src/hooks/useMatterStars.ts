import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

// The projects a lawyer has starred in the AI workspace: public.matter_stars
// (supabase/migrations/20261019120000_matter_stars.sql), one row per
// person and project, readable and writable only by that person.
//
// Until the migration is applied the table does not exist: reading then
// means "no stars", and starring says plainly that it is not set up yet.

export const STARS_NOT_READY = "Starring projects isn't switched on yet. Ask an administrator to apply the latest update.";

interface StarRow {
  user_id: string;
  matter_id: string;
  created_at: string;
}

// The table is not in the generated types until the migration is applied,
// so the three calls made here are typed by hand (the same client, the
// same PostgREST calls).
type StarsResult<T> = PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>;
interface StarsFilter<T> extends StarsResult<T> {
  eq(column: "user_id" | "matter_id", value: string): StarsFilter<T>;
}
interface StarsTable {
  select(columns: "matter_id"): StarsFilter<Array<Pick<StarRow, "matter_id">>>;
  upsert(values: Pick<StarRow, "user_id" | "matter_id">, options?: { onConflict?: string }): StarsResult<null>;
  delete(): StarsFilter<null>;
}
const stars = () => (supabase as unknown as { from(table: "matter_stars"): StarsTable }).from("matter_stars");

const tableMissing = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === "42P01" || error.code === "PGRST205" || /matter_stars/.test(error.message ?? ""));

export function useStarredMatters() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["matter-stars", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await stars().select("matter_id").eq("user_id", user!.id);
      if (error) {
        if (tableMissing(error)) return new Set();
        throw error;
      }
      return new Set((data ?? []).map((r) => r.matter_id));
    },
  });
}

export function useToggleStar() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, starred }: { matterId: string; starred: boolean }) => {
      if (!user?.id) throw new Error("Not signed in");
      const { error } = starred
        ? await stars().upsert({ user_id: user.id, matter_id: matterId }, { onConflict: "user_id,matter_id" })
        : await stars().delete().eq("user_id", user.id).eq("matter_id", matterId);
      if (error) throw tableMissing(error) ? new Error(STARS_NOT_READY) : error;
    },
    // The star fills at once; a refusal puts it back.
    onMutate: async ({ matterId, starred }) => {
      const key = ["matter-stars", user?.id];
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<Set<string>>(key);
      const next = new Set(before ?? []);
      if (starred) next.add(matterId);
      else next.delete(matterId);
      queryClient.setQueryData(key, next);
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.before) queryClient.setQueryData(["matter-stars", user?.id], ctx.before);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matter-stars", user?.id] });
    },
  });
}
