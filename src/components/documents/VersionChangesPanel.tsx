import { useEffect, useState } from "react";
import { FileDown, GitCompare, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  chatApiBase,
  compareOnDemand,
  exportChangesToWord,
  KIND_LABELS,
  NATURE_LABELS,
  wordSegments,
  type ChangeItem,
  type VersionChanges,
  type VersionInsights,
} from "./versionInsights";

// The "What changed" tab of the document preview: this version against the
// one saved before it (stored by the server when it read the file), or
// against any earlier version on request. Formatting-only changes (the
// contents page, cover dates, page headers, spacing) are hidden by default.

interface VersionRef {
  id: string;
  version_number: number;
  label: string | null;
}

const KIND_STYLE: Record<string, string> = {
  changed: "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-900",
  added: "bg-green-50 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-900",
  removed: "bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-900",
  moved: "bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-900",
};

function Plain({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-sm text-muted-foreground space-y-3">{children}</div>;
}

function Side({ item }: { item: ChangeItem }) {
  if (item.kind === "added") return <p className="text-sm break-words"><span className="bg-green-100 dark:bg-green-900/60">{item.after}</span></p>;
  if (item.kind === "removed") return <p className="text-sm break-words line-through decoration-red-500/70 text-muted-foreground">{item.before}</p>;
  const seg = wordSegments(item.before, item.after);
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      <p className="text-sm break-words text-muted-foreground">
        {seg.before.map((s, i) => (s.changed ? <del key={i} className="bg-red-100 dark:bg-red-900/60 decoration-red-500/70">{s.text}</del> : <span key={i}>{s.text}</span>))}
      </p>
      <p className="text-sm break-words">
        {seg.after.map((s, i) => (s.changed ? <ins key={i} className="no-underline bg-green-100 dark:bg-green-900/60">{s.text}</ins> : <span key={i}>{s.text}</span>))}
      </p>
    </div>
  );
}

export function VersionChangesPanel({
  documentTitle,
  version,
  versions,
  comparable,
  insights,
  loading,
  loadError,
}: {
  documentTitle: string;
  version: VersionRef;
  versions: VersionRef[];
  /** A Word, PDF or text file. */
  comparable: boolean;
  insights: VersionInsights | null;
  loading: boolean;
  loadError: string | null;
}) {
  const earlier = versions.filter((v) => v.version_number < version.version_number).sort((a, b) => b.version_number - a.version_number);
  const stored = insights?.changes ?? null;
  const storedBaseId = stored?.previous?.version_id ?? insights?.comparedWithId ?? earlier[0]?.id ?? null;
  const [baseId, setBaseId] = useState<string | null>(storedBaseId);
  const [hideFormatting, setHideFormatting] = useState(true);
  const [onDemand, setOnDemand] = useState<{ key: string; running: boolean; result: VersionChanges | null; error: string | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const canAsk = !!chatApiBase();

  // Another version, or the stored comparison arriving: start from it again.
  useEffect(() => {
    setBaseId(storedBaseId);
  }, [version.id, storedBaseId]);

  const base = earlier.find((v) => v.id === baseId) ?? earlier[0] ?? null;
  const onDemandKey = base ? `${base.id}:${version.id}` : "";
  const mine = onDemand?.key === onDemandKey ? onDemand : null;
  const usingStored = !!base && base.id === storedBaseId && !mine?.result;

  const ask = async (fromId: string) => {
    const key = `${fromId}:${version.id}`;
    setOnDemand({ key, running: true, result: null, error: null });
    try {
      const result = await compareOnDemand(fromId, version.id);
      setOnDemand({ key, running: false, result, error: null });
    } catch (err) {
      setOnDemand({ key, running: false, result: null, error: err instanceof Error ? err.message : "The comparison couldn't be made." });
    }
  };

  const pickBase = (id: string) => {
    setBaseId(id);
    if (id !== storedBaseId || !stored || stored.error || stored.skipped) {
      if (canAsk && onDemand?.key !== `${id}:${version.id}`) void ask(id);
    }
  };

  if (!earlier.length) return <Plain>This is the first version, so there is nothing to compare it with.</Plain>;
  if (loading && !insights) {
    return <Plain><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading the comparison…</span></Plain>;
  }
  if (loadError) return <Plain>{loadError}</Plain>;
  if (!comparable) return <Plain>Only Word, PDF and text files are compared.</Plain>;

  const result: VersionChanges | null = mine?.result ?? (usingStored ? stored : null);

  const picker = earlier.length > 1 && canAsk && (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Compare with</span>
      <Select value={base?.id ?? ""} onValueChange={pickBase}>
        <SelectTrigger className="h-8 w-auto min-w-[8rem] max-w-[16rem] text-xs" aria-label="Compare with version">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {earlier.map((v) => (
            <SelectItem key={v.id} value={v.id} className="text-xs">
              v{v.version_number}{v.label ? ` · ${v.label}` : ""}{v.id === storedBaseId ? " (previous)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  if (mine?.running) {
    return (
      <div className="p-4 space-y-3">
        {picker}
        <Plain><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Comparing v{base?.version_number} with v{version.version_number}…</span></Plain>
      </div>
    );
  }

  if (!result || result.error || result.skipped) {
    const status = insights?.indexingStatus;
    let why = "The comparison appears here once the server has read this version.";
    if (mine?.error) why = mine.error;
    else if (result?.error) why = `It could not be compared: ${result.error}`;
    else if (result?.skipped) why = result.skipped;
    else if (!usingStored) why = `This version has not been compared with v${base?.version_number} yet.`;
    else if (status === "pending" || status === "processing") why = "The server is still reading this version; the comparison appears when it finishes.";
    else if (status === "failed") why = "The server could not read this version, so it was not compared.";
    return (
      <div className="p-4 space-y-3">
        {picker}
        <div className="text-sm text-muted-foreground space-y-3 px-2">
          {!result?.error && !result?.skipped && !mine?.error && <p className="font-medium text-foreground">Not compared yet</p>}
          <p>{why}</p>
          {canAsk && base && !result?.skipped && (
            <Button size="sm" variant="outline" onClick={() => ask(base.id)}>
              <GitCompare className="h-4 w-4 mr-1.5" />Compare with v{base.version_number} now
            </Button>
          )}
        </div>
      </div>
    );
  }

  const all = result.items ?? [];
  const items = hideFormatting ? all.filter((i) => i.nature !== "formatting_only") : all;
  const hidden = all.length - all.filter((i) => i.nature !== "formatting_only").length;
  const counts = result.counts;
  const fromNumber = result.previous?.version_number ?? base?.version_number ?? version.version_number - 1;

  const doExport = async () => {
    setExporting(true);
    try {
      await exportChangesToWord({ title: documentTitle, fromVersion: fromNumber, toVersion: version.version_number, items, hiddenFormatting: hideFormatting ? hidden : 0 });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <p className="font-medium">
            v{fromNumber} → v{version.version_number}
            {counts && !result.unrelated && (
              <span className="font-normal text-muted-foreground">
                {" "}· {counts.changed ?? 0} changed, {counts.added ?? 0} added, {counts.removed ?? 0} removed{counts.moved ? `, ${counts.moved} moved` : ""}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {mine?.result ? "Compared on request" : "Compared by the server when it read this version"}
            {result.compared_at ? `, ${new Date(result.compared_at).toLocaleString()}` : ""}.
          </p>
        </div>
        {picker}
      </div>

      {!result.unrelated && all.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Checkbox id={`hide-formatting-${version.id}`} checked={hideFormatting} onCheckedChange={(v) => setHideFormatting(v === true)} />
            <Label htmlFor={`hide-formatting-${version.id}`} className="text-xs font-normal">
              Hide formatting-only{hidden ? ` (${hidden})` : ""}
            </Label>
          </div>
          <Button size="sm" variant="outline" onClick={doExport} disabled={exporting || !items.length} title="A Word table of the changes listed here">
            {exporting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileDown className="h-4 w-4 mr-1.5" />}Export to Word
          </Button>
        </div>
      )}

      {(result.notes ?? []).map((n, i) => (
        <p key={i} className="text-sm text-muted-foreground">{n}</p>
      ))}
      {!result.unrelated && all.length > 0 && items.length === 0 && (
        <p className="text-sm text-muted-foreground">Only formatting changed. Untick “Hide formatting-only” to see it.</p>
      )}

      {items.length > 0 && (
        <ul className="divide-y rounded-md border bg-background">
          {items.map((it, idx) => (
            <li key={idx} className="px-3 py-2.5 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold mr-1">{it.where}</span>
                <Badge variant="outline" className={cn("text-[11px] px-1.5 py-0 font-medium", KIND_STYLE[it.kind])}>{KIND_LABELS[it.kind] ?? it.kind}</Badge>
                <Badge variant="outline" className="text-[11px] px-1.5 py-0 font-normal">{NATURE_LABELS[it.nature] ?? it.nature}</Badge>
              </div>
              <Side item={it} />
            </li>
          ))}
        </ul>
      )}
      {(result.omitted ?? 0) > 0 && <p className="text-xs text-muted-foreground">…and {result.omitted} more changes not listed.</p>}
    </div>
  );
}
