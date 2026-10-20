// The small rules behind a stored version's Changes tab (a version marked up
// from claude.ai, whose changes are decided in the Hub). Kept free of the
// app's imports so the tests run them as the browser does.

/** The row of public.version_change_heads the viewer reads: the decided copy of a version. */
export interface VersionChangeHead {
  storage_path: string;
  file_name: string | null;
  updated_at: string | null;
}

/** What the viewer knows about a version before its list loads: how many change rows it has, and its decided copy. */
export interface VersionChangeState {
  rowCount: number;
  head: VersionChangeHead | null;
}

/**
 * The file the viewer draws for a version: the decided copy once a change
 * has been decided in it (every decision so far, the rest still tracked),
 * else the version's own file.
 */
export function viewerFileOf(version: { storage_path: string }, head: { storage_path?: string | null } | null | undefined): string {
  return head?.storage_path || version.storage_path;
}

/**
 * Whether the version gets a Changes tab. Once its list has loaded, the
 * list decides (an empty one hides the tab); before that, whether the
 * database holds change rows for it.
 */
export function showsChangesTab({ rowCount, listed }: { rowCount?: number | null; listed?: number | null }): boolean {
  if (typeof listed === "number") return listed > 0;
  return (rowCount ?? 0) > 0;
}

/** "Changes (3 waiting)", or "Changes" when nothing waits. */
export function changesTabLabel(waiting: number | null | undefined): string {
  return waiting && waiting > 0 ? `Changes (${waiting} waiting)` : "Changes";
}

/** A version with changes still waiting opens on its Changes tab. */
export function opensOnChanges(counts: { waiting?: number } | null | undefined): boolean {
  return (counts?.waiting ?? 0) > 0;
}

/**
 * The sentence for a decision the service refused. Someone else deciding
 * in the same version at the same moment (409 "changed while deciding") is
 * said plainly, with the list already reloaded; anything else is the
 * service's own sentence.
 */
export function decisionErrorText(status: number | null | undefined, message: string): string {
  if (status === 409 && /changed while/i.test(message)) {
    return "Someone decided a change in this document at the same moment, so nothing was recorded. The list has been reloaded to show where it stands now; decide again if you still need to.";
  }
  return message;
}

// PostgREST's and Postgres's words for a table that is not there (before
// the migration that adds version_change_heads has run).
const MISSING_TABLE = /PGRST205|42P01|does not exist|schema cache/i;

export function isMissingTable(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!error && MISSING_TABLE.test(`${error.code ?? ""} ${error.message ?? ""}`);
}
