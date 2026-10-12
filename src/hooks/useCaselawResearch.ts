import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

// A reported judgment the answer relied on, as the server's `sources` event
// carries it.
export interface CaselawSource {
  n: number;
  caseId: number | null;
  title: string;
  citations: string[];
  court: string | null;
  year: number | null;
  outcome: string | null;
  url: string | null;
  relevance: number;
  overruled: boolean;
  citedByCount: number;
  grounding: "full" | "summary";
}

export interface CaselawCoverage {
  variants: number;
  directHits: number;
  graphHits: number;
  poolSize: number;
  shortlisted: number;
  graded: number;
  onPoint: number;
  kept: number;
}

export interface CaselawPlan {
  issue: string;
  statutes: string[];
  variants: string[];
  yearFrom: number | null;
  yearTo: number | null;
  courts: string[];
}

export interface CaselawTurn {
  role: "user" | "assistant";
  content: string;
  tier?: "on_point" | "related";
  sources?: CaselawSource[];
  coverage?: CaselawCoverage;
  plan?: CaselawPlan;
  citationIssues?: number[];
  notices: string[];
  inProgress?: boolean;
  error?: string;
  stopped?: boolean;
}

// Drives one case-law research conversation: ask a question, stream the answer,
// and keep follow-ups in the same thread. Deliberately separate from useChat —
// the retrieval source, the sources shape and the coverage report are all
// specific to case law — but it reads the same SSE event vocabulary
// (meta/notice/delta/sources/done/error) chat-service established.
export function useCaselawResearch() {
  const { session } = useAuth();
  const [turns, setTurns] = useState<CaselawTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const threadId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const patchLast = useCallback((patch: (t: CaselawTurn) => CaselawTurn) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = patch(next[next.length - 1]);
      return next;
    });
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy || !session) return;

      setBusy(true);
      setTurns((prev) => [
        ...prev,
        { role: "user", content: q, notices: [] },
        { role: "assistant", content: "", notices: [], inProgress: true },
      ]);

      const abort = new AbortController();
      controller.current = abort;

      // The endpoint is the case-law service on the VM; its base comes from
      // VITE_CASELAW_API_URL (e.g. https://aklacaselaw.duckdns.org/caselaw).
      const url = (import.meta.env.VITE_CASELAW_API_URL as string | undefined)?.replace(/\/$/, "") || "";
      if (!url) {
        patchLast((t) => ({ ...t, inProgress: false, error: "Case-law research is not configured (VITE_CASELAW_API_URL)." }));
        setBusy(false);
        return;
      }

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ question: q, threadId: threadId.current }),
          signal: abort.signal,
        });
        if (!resp.ok || !resp.body) {
          let detail = `Request failed (${resp.status})`;
          try { detail = (await resp.json()).error ?? detail; } catch { /* not json */ }
          throw new Error(detail);
        }

        const handle = (event: string, data: any) => {
          switch (event) {
            case "meta":
              if (data.threadId) threadId.current = data.threadId;
              break;
            case "notice":
              patchLast((t) => ({ ...t, notices: [...t.notices, data.text] }));
              break;
            case "delta":
              patchLast((t) => ({ ...t, content: t.content + data.text }));
              break;
            case "sources":
              patchLast((t) => ({ ...t, tier: data.tier, sources: data.sources }));
              break;
            case "done":
              patchLast((t) => ({
                ...t,
                inProgress: false,
                tier: data.tier,
                plan: data.plan,
                coverage: data.coverage,
                citationIssues: data.citationIssues,
                stopped: data.stopReason === "stopped",
              }));
              break;
            case "error":
              patchLast((t) => ({ ...t, inProgress: false, error: data.message }));
              break;
          }
        };

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
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
            if (!dataLine) continue;
            try { handle(event, JSON.parse(dataLine)); } catch { /* skip malformed frame */ }
          }
        }
        // Finished streaming without an explicit done (e.g. the lawyer stopped).
        patchLast((t) => (t.inProgress ? { ...t, inProgress: false, stopped: abort.signal.aborted } : t));
      } catch (err: any) {
        if (abort.signal.aborted) {
          patchLast((t) => ({ ...t, inProgress: false, stopped: true }));
        } else {
          patchLast((t) => ({ ...t, inProgress: false, error: err.message ?? "Case-law research failed" }));
        }
      } finally {
        controller.current = null;
        setBusy(false);
      }
    },
    [busy, session, patchLast],
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    threadId.current = null;
    setTurns([]);
    setBusy(false);
  }, []);

  return { turns, busy, ask, stop, reset };
}
