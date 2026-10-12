import { useRef, useState, useEffect } from "react";
import { Scale, ExternalLink, Send, Square, RotateCcw, AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import MarkdownMessage from "@/components/ai/chat/MarkdownMessage";
import { useCaselawResearch, type CaselawSource, type CaselawTurn } from "@/hooks/useCaselawResearch";

const EMPTY_ARTIFACTS = new Map();
const noop = () => {};

// Case-law research: ask a legal question, get an answer grounded in reported
// Pakistani judgments with the authorities it relied on. A separate workspace
// from the AI Workspace chat — different source, different output.
export default function CaselawResearchPage() {
  const { turns, busy, ask, stop, reset } = useCaselawResearch();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const submit = () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    ask(q);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <Scale className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Case-Law Research</h1>
            <p className="text-xs text-muted-foreground">Answers grounded in reported Pakistani judgments, with the authorities cited.</p>
          </div>
        </div>
        {turns.length > 0 && (
          <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
            <RotateCcw className="h-4 w-4 mr-2" /> New research
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {turns.length === 0 && <EmptyState onPick={(q) => { setDraft(q); }} />}
        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}
      </div>

      <div className="border-t px-6 py-4">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="e.g. Have there been any judgments on unsolicited proposals in PPP projects since 2015?"
            className="min-h-[52px] max-h-40 resize-none"
            disabled={busy}
          />
          {busy ? (
            <Button variant="outline" onClick={stop} className="h-[52px]">
              <Square className="h-4 w-4 mr-2" /> Stop
            </Button>
          ) : (
            <Button onClick={submit} disabled={!draft.trim()} className="h-[52px]">
              <Send className="h-4 w-4 mr-2" /> Ask
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Research assistance, not legal advice. Verify every authority against the official report before relying on it.
        </p>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const examples = [
    "What is the standard for granting pre-arrest bail in narcotics cases under the CNSA?",
    "Have the superior courts ruled on unsolicited proposals in public-private partnership projects?",
    "How have the courts treated the doctrine of frustration in commercial contracts?",
  ];
  return (
    <div className="max-w-xl mx-auto text-center pt-10">
      <Scale className="h-10 w-10 text-muted-foreground/50 mx-auto mb-4" />
      <h2 className="text-base font-medium">Ask a question of Pakistani case law</h2>
      <p className="text-sm text-muted-foreground mt-1 mb-5">
        The question is searched many ways and expanded through the citation graph, so relevant judgments aren&apos;t missed.
      </p>
      <div className="space-y-2 text-left">
        {examples.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="w-full rounded-lg border px-4 py-3 text-sm text-left hover:bg-accent transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: CaselawTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-2xl rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm">
          {turn.content}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-3">
      {turn.inProgress && turn.notices.length > 0 && !turn.content && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          {turn.notices[turn.notices.length - 1]}
        </div>
      )}

      {turn.tier === "related" && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>No judgment is squarely on point for this question. The authorities below are the nearest related cases.</span>
        </div>
      )}

      {turn.content && (
        // Case-law answers carry no artifacts (no drafts/memos produced), so an
        // empty map and a no-op opener satisfy the shared renderer's contract.
        <MarkdownMessage content={turn.content} artifacts={EMPTY_ARTIFACTS} onOpenArtifact={noop} inProgress={turn.inProgress} />
      )}

      {turn.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{turn.error}</span>
        </div>
      )}

      {turn.citationIssues && turn.citationIssues.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>The draft referenced source numbers that aren&apos;t in the list ({turn.citationIssues.join(", ")}). Re-check before relying on it.</span>
        </div>
      )}

      {turn.sources && turn.sources.length > 0 && <SourcesPanel sources={turn.sources} />}

      {turn.coverage && !turn.inProgress && <CoverageLine turn={turn} />}
    </div>
  );
}

function SourcesPanel({ sources }: { sources: CaselawSource[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Authorities</h3>
      {sources.map((s) => (
        <Card key={s.n} className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-muted-foreground">[{s.n}]</span>
                <span className="text-sm font-medium">{s.citations[0] ?? s.title}</span>
                {s.overruled && <Badge variant="destructive" className="text-[10px]">overruled</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{s.title}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground flex-wrap">
                {s.court && <span>{s.court}</span>}
                {s.year && <span>· {s.year}</span>}
                {s.citedByCount > 0 && <span>· cited by {s.citedByCount}</span>}
                <span>· {s.grounding === "full" ? "full text read" : "summary only"}</span>
              </div>
            </div>
            {s.url && (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" title="Open judgment">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function CoverageLine({ turn }: { turn: CaselawTurn }) {
  const c = turn.coverage!;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">
        Searched {c.variants} ways · {c.poolSize} judgments found · {c.kept} cited ({c.onPoint} squarely on point)
      </summary>
      <div className="mt-2 pl-3 border-l space-y-1">
        <div>{c.directHits} from search, {c.graphHits} more from the citation graph.</div>
        <div>Shortlisted {c.shortlisted}, graded {c.graded}, kept {c.kept}.</div>
        {turn.plan?.statutes && turn.plan.statutes.length > 0 && (
          <div>Statutes considered: {turn.plan.statutes.join("; ")}</div>
        )}
        {turn.plan?.variants && turn.plan.variants.length > 0 && (
          <div>Query variants: {turn.plan.variants.join(" / ")}</div>
        )}
      </div>
    </details>
  );
}
