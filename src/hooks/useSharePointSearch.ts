import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SharePointFile {
  name: string;
  /** Opens the file on SharePoint. */
  webUrl: string;
  /** The folder inside the Data Room, e.g. "Usama - Backup/Active Transactions". */
  folder: string;
  folderUrl: string;
  modified: string | null;
  size: number | null;
  /** One sentence from the assistant on why this file answers the request. */
  why: string;
  /** unchecked: found by word only; the assistant ran out of time before judging it. */
  fit: "strong" | "possible" | "unchecked";
  /** The assistant opened the file and read it, rather than judging by its name. */
  opened: boolean;
}

export interface SharePointSearchResult {
  query: string;
  results: SharePointFile[];
  note: string | null;
  searches: string[];
  seen: number;
  opened: number;
  complete: boolean;
}

interface SearchState {
  query: string;
  running: boolean;
  /** What the assistant is doing, newest last. */
  steps: string[];
  result: SharePointSearchResult | null;
  error: string | null;
}

const IDLE: SearchState = { query: "", running: false, steps: [], result: null, error: null };

// Finished searches of this visit. A search costs a wait and an AI call, so
// coming back to one (the browser's Back, switching tabs) shows it again
// instead of running it again.
const finished = new Map<string, SharePointSearchResult>();

/**
 * "Search SharePoint": the chat server's assistant looks through the firm's
 * Data Room for the file described. The answer streams: a step as each
 * search or file read starts, then the result.
 */
export function useSharePointSearch() {
  const [state, setState] = useState<SearchState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => (s.running ? { ...s, running: false, error: "Search stopped." } : s));
  }, []);

  const run = useCallback(async (rawQuery: string, { again = false }: { again?: boolean } = {}) => {
    const query = rawQuery.trim();
    abortRef.current?.abort();
    abortRef.current = null;
    if (!query) return setState(IDLE);
    const kept = again ? undefined : finished.get(query);
    if (kept) return setState({ query, running: false, steps: [], result: kept, error: null });

    const abort = new AbortController();
    abortRef.current = abort;
    setState({ query, running: true, steps: [], result: null, error: null });
    const fail = (error: string) => {
      if (abortRef.current === abort) setState((s) => ({ ...s, running: false, error }));
    };
    try {
      const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
      if (!base) return fail("SharePoint search isn't available right now. Ask an administrator to check the AI service.");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return fail("You are signed out. Sign in and search again.");
      const resp = await fetch(`${base}/sharepoint/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) {
        const body = await resp.json().catch(() => ({}));
        // A server from before this page was built has no such address.
        if (resp.status === 404) return fail("SharePoint search is not switched on yet.");
        return fail(body.error ?? `The search failed (${resp.status}).`);
      }

      let done = false;
      const handle = (event: string, data: unknown) => {
        if (abortRef.current !== abort) return;
        const said = (data ?? {}) as { text?: unknown; error?: unknown };
        if (event === "step" && said.text) setState((s) => ({ ...s, steps: [...s.steps, String(said.text)] }));
        else if (event === "result") {
          done = true;
          const result = data as SharePointSearchResult;
          finished.set(query, result);
          setState((s) => ({ ...s, running: false, result }));
        } else if (event === "error") {
          done = true;
          setState((s) => ({ ...s, running: false, error: typeof said.error === "string" ? said.error : "The search could not be finished." }));
        }
      };
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          let event = "message";
          let dataLine = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (dataLine) handle(event, JSON.parse(dataLine));
        }
      }
      if (!done) fail("The connection ended before the search finished. Search again.");
    } catch (err) {
      if (abort.signal.aborted) return;
      fail(err instanceof Error && err.message !== "Failed to fetch" && err.message !== "Load failed" ? err.message : "The search could not reach the server. Check your connection and search again.");
    }
  }, []);

  // Leaving the page stops a search still running; the server stops with it.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { ...state, run, stop };
}
