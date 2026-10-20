import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  ChatApiError,
  chatApiBase,
  decideVersionChanges,
  listVersionChanges,
  type Decision,
  type VersionChangesList,
  type VersionDecideResult,
} from "@/lib/documentSave";
import { decisionErrorText, isMissingTable, type VersionChangeHead, type VersionChangeState } from "@/lib/versionChangesRules";

// The Changes list of a stored project version: one the claude.ai
// connector marked up (apply_tracked_changes) and filed as the next version
// of its document, with one change row per tracked change. The rows and the
// decided copy are the chat service's (chat-service/versionChanges.js); the
// list shows what comes back verbatim, as a chat's list does.
//
// Two reads, keyed on the version:
// - the change state, straight from the database: how many change rows the
//   version has (so a version without any never calls the chat service) and
//   its decided copy (public.version_change_heads), which the viewer draws
//   in place of the version's own file once a change has been decided;
// - the list itself, from the chat service, only for a version with rows.

export const versionChangesKey = (versionId: string | null | undefined) => ["version-changes", versionId ?? null] as const;
export const versionChangeStateKey = (versionId: string | null | undefined) => ["version-change-state", versionId ?? null] as const;

// version_change_heads is newer than the generated types.
type HeadsTable = {
  select(columns: string): {
    eq(column: "document_version_id", value: string): {
      maybeSingle(): PromiseLike<{ data: VersionChangeHead | null; error: { code?: string; message?: string } | null }>;
    };
  };
};
const heads = () => (supabase as unknown as { from(table: "version_change_heads"): HeadsTable }).from("version_change_heads");

async function readChangeState(versionId: string): Promise<VersionChangeState> {
  const [rows, head] = await Promise.all([
    // The rows the version's list is made of (versionChanges.js versionRows):
    // a legacy review's suggestions on the same version are not among them.
    supabase
      .from("redline_suggestions")
      .select("id", { count: "exact", head: true })
      .eq("document_version_id", versionId)
      .is("artifact_id", null)
      .eq("review_type", "edit"),
    heads().select("storage_path, file_name, updated_at").eq("document_version_id", versionId).maybeSingle(),
  ]);
  if (rows.error) throw rows.error;
  // Before the migration that adds the table no decision can have been kept.
  if (head.error && !isMissingTable(head.error)) throw head.error;
  return { rowCount: rows.count ?? 0, head: head.data?.storage_path ? head.data : null };
}

/** How many change rows a version has, and its decided copy. Undefined id: nothing is read. */
export function useVersionChangeState(versionId: string | null | undefined) {
  return useQuery({
    queryKey: versionChangeStateKey(versionId),
    enabled: !!versionId,
    queryFn: () => readChangeState(versionId!),
    staleTime: 10_000,
    retry: 1,
  });
}

/**
 * The version's Changes list and decide(). `enabled` is the caller's word
 * that the version has change rows; the list is only asked for then.
 */
export function useVersionChanges(versionId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  const available = !!chatApiBase();

  const list = useQuery({
    queryKey: versionChangesKey(versionId),
    enabled: available && enabled && !!versionId,
    queryFn: () => listVersionChanges(versionId!),
    staleTime: 10_000,
    retry: 1,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: versionChangesKey(versionId) });
    queryClient.invalidateQueries({ queryKey: versionChangeStateKey(versionId) });
  };

  const decide = useMutation({
    mutationFn: async (decisions: Decision[]): Promise<VersionDecideResult> => {
      if (!versionId) throw new Error("No document is open.");
      try {
        return await decideVersionChanges(versionId, decisions);
      } catch (err) {
        if (err instanceof ChatApiError) throw new ChatApiError(err.status, decisionErrorText(err.status, err.message), err.body);
        throw err;
      }
    },
    onSuccess: (result) => {
      const decided = new Map(result.changes.map((c) => [c.id, c]));
      queryClient.setQueryData<VersionChangesList>(versionChangesKey(versionId), (old) =>
        old ? { ...old, head: result.head, counts: result.counts, changes: old.changes.map((c) => decided.get(c.id) ?? c) } : old,
      );
      // The viewer draws the decided copy straight away.
      if (result.head.decided) {
        queryClient.setQueryData<VersionChangeState>(versionChangeStateKey(versionId), (old) => ({
          rowCount: old?.rowCount ?? result.changes.length,
          head: { storage_path: result.head.storagePath, file_name: result.head.fileName, updated_at: result.head.updatedAt },
        }));
      }
      refresh();
    },
    // A 409 means someone else decided meanwhile: show where it is now.
    onError: refresh,
  });

  return {
    available,
    list,
    cards: list.data?.changes,
    counts: list.data?.counts ?? null,
    head: list.data?.head ?? null,
    loading: list.isLoading,
    error: list.error ? (list.error as Error).message : null,
    reload: () => list.refetch(),
    decide: (decisions: Decision[]) => decide.mutateAsync(decisions),
    deciding: decide.isPending,
  };
}
