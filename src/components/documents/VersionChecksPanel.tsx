import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, CATEGORY_ORDER, chatApiBase, checkOnDemand, type ProofCheck, type ProofItem, type VersionInsights } from "./versionInsights";

// The Checks tab of the document preview: blanks, references to nothing,
// numbers whose words and figures disagree, terms and numbering, grouped by
// kind. Clicking a finding shows it in the Word preview.

const SEVERITY_DOT: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-slate-400",
};
const SEVERITY_WORD: Record<string, string> = { high: "Fix before it goes out", medium: "Check", low: "Worth a look" };

function Plain({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-sm text-muted-foreground space-y-3">{children}</div>;
}

export function VersionChecksPanel({
  versionId,
  versionNumber,
  checkable,
  insights,
  loading,
  loadError,
  onFind,
}: {
  versionId: string;
  versionNumber: number;
  /** A Word, PDF or text file. */
  checkable: boolean;
  insights: VersionInsights | null;
  loading: boolean;
  loadError: string | null;
  /** Shows the text in the preview; absent when the preview cannot be searched. */
  onFind?: (text: string) => boolean;
}) {
  const [onDemand, setOnDemand] = useState<{ forId: string; running: boolean; result: ProofCheck | null; error: string | null } | null>(null);
  const [missed, setMissed] = useState<string | null>(null);
  const mine = onDemand?.forId === versionId ? onDemand : null;

  const runNow = async () => {
    setOnDemand({ forId: versionId, running: true, result: null, error: null });
    try {
      const result = await checkOnDemand(versionId);
      setOnDemand({ forId: versionId, running: false, result, error: null });
    } catch (err) {
      setOnDemand({ forId: versionId, running: false, result: null, error: err instanceof Error ? err.message : "The check couldn't be run." });
    }
  };

  if (loading && !insights) {
    return <Plain><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading the checks…</span></Plain>;
  }
  if (loadError) return <Plain>{loadError}</Plain>;
  if (!checkable) return <Plain>Checks run on Word, PDF and text files only.</Plain>;

  const check = mine?.result ?? insights?.proofCheck ?? null;
  const canRunNow = !!chatApiBase();

  if (!check || check.error || check.skipped) {
    const status = insights?.indexingStatus;
    let why = "The checks appear here once the server has read this version.";
    if (check?.error) why = `The checks could not be run on this version: ${check.error}`;
    else if (check?.skipped) why = check.skipped;
    else if (status === "pending" || status === "processing") why = "The server is still reading this version; the checks appear when it finishes.";
    else if (status === "failed") why = "The server could not read this version, so it was not checked.";
    return (
      <Plain>
        {!check?.error && !check?.skipped && <p className="font-medium text-foreground">Not checked yet</p>}
        <p>{why}</p>
        {canRunNow && !check?.skipped && (
          <Button size="sm" variant="outline" onClick={runNow} disabled={mine?.running}>
            {mine?.running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ScanSearch className="h-4 w-4 mr-1.5" />}
            {mine?.running ? "Checking…" : "Check now"}
          </Button>
        )}
        {mine?.error && <p className="text-destructive">{mine.error}</p>}
      </Plain>
    );
  }

  const items = check.items ?? [];
  const counts = check.counts ?? {};
  const total = check.total ?? items.length;
  const groups = CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) > 0);
  const clean = CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) === 0);

  const find = (it: ProofItem) => {
    if (!onFind) return;
    const found = onFind(it.find || it.text);
    setMissed(found ? null : `${it.where}: that spot couldn't be found in the preview. Look for “${(it.find || it.text).slice(0, 60)}”.`);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start gap-2">
        {total === 0 ? <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" /> : <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />}
        <div className="text-sm">
          <p className="font-medium">
            {total === 0 ? `Nothing to report in v${versionNumber}.` : `${total} thing${total === 1 ? "" : "s"} to look at in v${versionNumber}.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Checked {check.checked_at ? new Date(check.checked_at).toLocaleString() : ""}{mine?.result ? " (on request)" : ""}. These are mechanical checks; they do not read the law.
            {onFind ? " Click a finding to see it in the document." : ""}
          </p>
        </div>
      </div>
      {missed && <p className="text-xs text-muted-foreground">{missed}</p>}

      {groups.map((category) => {
        const list = items.filter((i) => i.category === category);
        const more = check.omitted?.[category] ?? 0;
        return (
          <section key={category} className="space-y-1.5">
            <h3 className="text-sm font-semibold">
              {CATEGORY_LABELS[category] ?? category} <span className="text-muted-foreground font-normal">({counts[category]})</span>
            </h3>
            <ul className="divide-y rounded-md border bg-background">
              {list.map((it, idx) => {
                const body = (
                  <>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={cn("h-2 w-2 rounded-full shrink-0", SEVERITY_DOT[it.severity] ?? SEVERITY_DOT.low)} title={SEVERITY_WORD[it.severity]} aria-label={SEVERITY_WORD[it.severity]} />
                      <span className="font-medium">{it.where}</span>
                    </div>
                    <p className="text-sm mt-0.5">{it.note}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 break-words">{it.text}</p>
                  </>
                );
                return (
                  <li key={idx}>
                    {onFind ? (
                      <button type="button" className="w-full text-left px-3 py-2 hover:bg-muted/60 focus-visible:outline-none focus-visible:bg-muted/60" onClick={() => find(it)}>
                        {body}
                      </button>
                    ) : (
                      <div className="px-3 py-2">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {more > 0 && <p className="text-xs text-muted-foreground">…and {more} more not listed.</p>}
          </section>
        );
      })}

      {total > 0 && clean.length > 0 && (
        <p className="text-xs text-muted-foreground">Nothing found for: {clean.map((c) => (CATEGORY_LABELS[c] ?? c).toLowerCase()).join("; ")}.</p>
      )}
      {(check.notes ?? []).map((n, i) => (
        <p key={i} className="text-xs text-muted-foreground">{n}</p>
      ))}
    </div>
  );
}
