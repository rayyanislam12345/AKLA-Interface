// The AI workspace's search (⌘K) before the search RPC exists: three plain
// "contains" queries, one each over chats, projects and documents. The
// pieces that need no network live here so tests/aiSearch.test.js can run
// them in Node.

/** The shortest query worth a round trip. */
export const MIN_SEARCH_LENGTH = 2;

/** Escapes a query for an ilike pattern: % and _ are wildcards there, and a backslash escapes. */
export function likePattern(query: string): string {
  const escaped = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

export function searchable(query: string): boolean {
  return query.trim().length >= MIN_SEARCH_LENGTH;
}

export interface AiSearchChat {
  id: string;
  title: string | null;
  matterId: string | null;
  matterName: string | null;
  lastMessageAt: string | null;
}

export interface AiSearchProject {
  id: string;
  name: string;
  clientName: string | null;
  status: string;
}

export interface AiSearchDocument {
  id: string;
  title: string;
  matterId: string;
  matterName: string | null;
  /** The newest version, to open in the document window; null for a document with no file yet. */
  latestVersionId: string | null;
  versionCount: number;
}

export interface AiSearchResults {
  chats: AiSearchChat[];
  projects: AiSearchProject[];
  documents: AiSearchDocument[];
}

export const EMPTY_RESULTS: AiSearchResults = { chats: [], projects: [], documents: [] };

/** The newest of a document's versions, by version number. */
export function newestVersionId(versions: Array<{ id: string; version_number: number }> | null | undefined): string | null {
  let best: { id: string; version_number: number } | null = null;
  for (const v of versions ?? []) if (!best || v.version_number > best.version_number) best = v;
  return best?.id ?? null;
}

/** Where picking a search result goes in the workspace. */
export function searchResultPath(result: { kind: "chat"; id: string } | { kind: "project"; id: string } | { kind: "document"; matterId: string; latestVersionId: string | null }): string {
  switch (result.kind) {
    case "chat":
      return `/ai/c/${result.id}`;
    case "project":
      return `/ai/p/${result.id}`;
    case "document":
      return result.latestVersionId ? `/ai/p/${result.matterId}?open=v:${result.latestVersionId}` : `/ai/p/${result.matterId}`;
  }
}
