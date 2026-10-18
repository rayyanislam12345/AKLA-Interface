import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { EMPTY_RESULTS, likePattern, newestVersionId, searchable, type AiSearchResults } from "@/lib/aiSearch";

// The AI workspace's search box: chats, projects and documents whose titles
// contain what was typed. Three plain queries in parallel until the
// search_ai_workspace RPC exists; the typed text is held back for a moment
// so a word in progress is not searched letter by letter.

const DEBOUNCE_MS = 200;
const LIMIT = 8;

export function useDebouncedValue<T>(value: T, delay = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function useAiSearch(query: string) {
  const { user } = useAuth();
  const q = useDebouncedValue(query.trim());
  const active = !!user?.id && searchable(q);
  const result = useQuery({
    queryKey: ["ai-search", user?.id, q],
    enabled: active,
    staleTime: 30_000,
    queryFn: async (): Promise<AiSearchResults> => {
      const pattern = likePattern(q);
      const [chats, projects, documents] = await Promise.all([
        supabase
          .from("ai_chat_threads")
          .select("id, title, matter_id, last_message_at, matter:matters(name)")
          .eq("created_by", user!.id)
          .is("document_type_id", null)
          .eq("archived", false)
          .ilike("title", pattern)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(LIMIT),
        supabase.from("matters").select("id, name, status, client:clients(name)").ilike("name", pattern).order("created_at", { ascending: false }).limit(LIMIT),
        supabase
          .from("matter_documents")
          .select("id, title, matter_id, matter:matters(name), versions:document_versions(id, version_number)")
          .ilike("title", pattern)
          .order("created_at", { ascending: false })
          .limit(LIMIT),
      ]);
      const failed = chats.error ?? projects.error ?? documents.error;
      if (failed) throw failed;
      type ChatRow = { id: string; title: string | null; matter_id: string | null; last_message_at: string | null; matter: { name: string } | null };
      type ProjectRow = { id: string; name: string; status: string; client: { name: string } | null };
      type DocumentRow = { id: string; title: string; matter_id: string; matter: { name: string } | null; versions: Array<{ id: string; version_number: number }> | null };
      return {
        chats: ((chats.data ?? []) as unknown as ChatRow[]).map((t) => ({ id: t.id, title: t.title, matterId: t.matter_id, matterName: t.matter?.name ?? null, lastMessageAt: t.last_message_at })),
        projects: ((projects.data ?? []) as unknown as ProjectRow[]).map((m) => ({ id: m.id, name: m.name, clientName: m.client?.name ?? null, status: m.status })),
        documents: ((documents.data ?? []) as unknown as DocumentRow[]).map((d) => ({
          id: d.id,
          title: d.title,
          matterId: d.matter_id,
          matterName: d.matter?.name ?? null,
          latestVersionId: newestVersionId(d.versions),
          versionCount: d.versions?.length ?? 0,
        })),
      };
    },
  });
  return {
    /** The text the results are for (after the pause). */
    query: q,
    active,
    results: active ? result.data ?? EMPTY_RESULTS : EMPTY_RESULTS,
    // Searching: typed text the results have not caught up with, or a round trip in flight.
    searching: active && (result.isFetching || q !== query.trim()),
    error: active ? result.error : null,
    refetch: result.refetch,
  };
}
