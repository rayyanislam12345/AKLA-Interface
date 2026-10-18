// Whether search and Ask AI can read a project file version, in words a
// lawyer can act on. Shared by the project page on the site and the AI
// workspace's Files panel. Pure: no React, no Supabase; tested in
// tests/documentReadState.test.js.
//
// "unknown" (versions saved before the status was recorded) and a "pending"
// that has sat for more than ten minutes are treated as failed: they get the
// one automatic retry and a Try again button, never a spinner that turns
// forever.
//
// With the index worker (20261017090000_indexing_pipeline.sql) the server owns
// the state: a version is waiting in the queue, being read, searchable, or
// failed with a reason (indexing_error) after three tries. The worker retries
// on its own, so no timeout or automatic retry is needed here; the version
// rows then carry indexing_attempts, which is how a page tells the two
// apart before and after the migration.

export const READING_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_READ_ATTEMPTS = 3;

export type ReadState = "searchable" | "waiting" | "reading" | "failed" | "unsupported";

export type VersionIndexing = {
  indexing_status: string;
  created_at: string;
  indexing_error?: string | null;
  indexing_attempts?: number | null;
  indexing_started_at?: string | null;
};

/** True once the version rows carry the index worker's columns. */
export const hasIndexQueue = (v: VersionIndexing) => v.indexing_attempts !== undefined;

export function versionReadState(v: VersionIndexing, now: number): ReadState {
  if (v.indexing_status === "indexed") return "searchable";
  if (v.indexing_status === "unsupported") return "unsupported";
  if (hasIndexQueue(v)) {
    if (v.indexing_status === "pending") return v.indexing_started_at ? "reading" : "waiting";
    return "failed";
  }
  if (v.indexing_status === "pending" && now - new Date(v.created_at).getTime() < READING_TIMEOUT_MS) return "reading";
  return "failed";
}

export const READ_STATE_LABEL: Record<ReadState, string> = {
  searchable: "Searchable",
  waiting: "Waiting to be read",
  reading: "Reading…",
  failed: "Couldn't be read",
  unsupported: "Not searchable (file type)",
};

export const READ_STATE_HINT: Record<ReadState, string> = {
  searchable: "Search and Ask AI can read this version.",
  waiting: "In the queue. Files are read one at a time on the server; you can carry on working.",
  reading: "Reading the text so search and Ask AI can use it. A long scanned PDF can take a while.",
  failed: "The file is saved, but search and Ask AI can't read it yet. Press Try again.",
  unsupported: "This file type can't be read for search. The file is saved and can be downloaded.",
};

/** The badge's hint, with the server's reason when there is one. */
export function readStateHint(v: VersionIndexing, state: ReadState): string {
  if (state === "failed" && v.indexing_error) return `${v.indexing_error} The file is saved and can be downloaded.`;
  if (state === "failed" && hasIndexQueue(v) && v.indexing_status === "unknown") {
    return "Saved before files were read automatically. Press Try again to read it now.";
  }
  if (state === "reading" && (v.indexing_attempts ?? 0) > 1) {
    return `Reading it again (attempt ${v.indexing_attempts} of ${MAX_READ_ATTEMPTS}) after a problem last time.`;
  }
  return READ_STATE_HINT[state];
}
