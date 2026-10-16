import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, CircleSlash, FileText, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DocumentIntake, IntakeItem, IntakePlanRow } from "./useDocumentIntake";

const STATUS_LABEL: Record<IntakeItem["status"], string> = {
  checking: "Checking…",
  ready: "Ready",
  waiting: "Waiting",
  uploading: "Uploading…",
  reading: "Reading…",
  searchable: "Searchable",
  saved: "Saved, not searchable",
  duplicate: "Already in the project",
  failed: "Failed",
};

function statusBadge(item: IntakeItem) {
  const label = item.status === "duplicate" && item.duplicateOf === "upload" ? "Listed twice" : STATUS_LABEL[item.status];
  const spinning = item.status === "checking" || item.status === "uploading" || item.status === "reading";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] gap-1 shrink-0 font-normal",
        item.status === "searchable" && "border-green-600/50 text-green-700 dark:text-green-400",
        item.status === "failed" && "border-destructive/60 text-destructive",
        item.status === "saved" && "border-amber-500/60 text-amber-700 dark:text-amber-400",
        item.status === "duplicate" && "text-muted-foreground",
      )}
    >
      {spinning && <Loader2 className="h-3 w-3 animate-spin" />}
      {item.status === "searchable" && <Check className="h-3 w-3" />}
      {item.status === "duplicate" && <CircleSlash className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

function whatHappens(row: IntakePlanRow | undefined): ReactNode {
  if (!row) return null;
  const a = row.action;
  if (a.kind === "skip") return "Skipped";
  if (a.kind === "existing") return <>New version of <span className="font-medium text-foreground">{a.title}</span></>;
  if (a.kind === "batch") return <>New version of <span className="font-medium text-foreground">{a.title}</span> (added in this upload)</>;
  return <>New document: <span className="font-medium text-foreground">{a.title}</span></>;
}

export function DocumentIntakePanel({ intake }: { intake: DocumentIntake }) {
  const { items, plan, problems } = intake;
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length && !problems.length && !intake.gathering) return null;

  const counts = {
    done: items.filter((i) => i.status === "searchable" || i.status === "saved").length,
    duplicate: items.filter((i) => i.status === "duplicate").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
  const unappliedSuggestions = items.filter((i) => {
    const row = plan.get(i.id);
    return i.status === "ready" && row?.suggestion && !row.asVersion;
  }).length;
  const finished = items.some((i) => ["searchable", "saved", "duplicate"].includes(i.status));

  return (
    <div className="rounded-md border bg-muted/20" aria-live="polite">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b">
        <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {intake.gathering ? "Gathering files…" : `${items.length} file${items.length === 1 ? "" : "s"} to add`}
          </p>
          <p className="text-xs text-muted-foreground">
            {intake.readyCount > 0
              ? "Check what will happen to each file, then press Start."
              : intake.running
                ? "Uploading two at a time. You can keep working on this page."
                : [
                    counts.done ? `${counts.done} saved` : "",
                    counts.duplicate ? `${counts.duplicate} skipped as already in the project` : "",
                    counts.failed ? `${counts.failed} failed` : "",
                  ].filter(Boolean).join(" · ") || "Checking files…"}
          </p>
        </div>
        {unappliedSuggestions > 0 && (
          <Button size="sm" variant="outline" onClick={intake.applyAllSuggestions}>
            Apply all suggestions ({unappliedSuggestions})
          </Button>
        )}
        {intake.readyCount > 0 && (
          <Button size="sm" onClick={intake.start} disabled={intake.checking || intake.gathering}>
            {intake.checking || intake.gathering ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Checking files…</>
            ) : (
              <>Start ({intake.readyCount})</>
            )}
          </Button>
        )}
        {finished && !intake.readyCount && (
          <Button size="sm" variant="ghost" onClick={intake.clearFinished}>Clear finished</Button>
        )}
        {!intake.running && intake.readyCount > 0 && (
          <Button size="sm" variant="ghost" onClick={intake.clearAll}>Clear list</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {collapsed ? "Show list" : "Hide list"}
        </Button>
      </div>

      {problems.length > 0 && (
        <div className="px-3 py-2 border-b text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
          {problems.map((p, i) => (
            <p key={i} className="flex gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{p}</p>
          ))}
        </div>
      )}

      {!collapsed && (
        <ul className="max-h-96 overflow-y-auto divide-y">
          {items.map((item) => {
            const row = plan.get(item.id);
            const editable = item.status === "ready" || item.status === "checking";
            return (
              <li key={item.id} className="px-3 py-2 flex items-start gap-2 flex-wrap sm:flex-nowrap">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" title={item.path}>{item.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {whatHappens(row)}
                    {item.label && row?.action.kind !== "skip" ? <> · <span title="Version label, from the file name">{item.label}</span></> : null}
                  </p>
                  {item.note && (
                    <p className={cn("text-xs mt-0.5", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{item.note}</p>
                  )}
                  {editable && row?.suggestion && (
                    <Select
                      value={row.asVersion ? "version" : "new"}
                      onValueChange={(v) => intake.setAsVersion(item.id, v === "version")}
                    >
                      <SelectTrigger className="h-7 mt-1 text-xs w-full sm:w-auto sm:max-w-[22rem]" aria-label="What to do with this file">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="version" className="text-xs">
                          New version of "{row.suggestion.title}"
                          {row.suggestion.kind === "existing" && !row.suggestion.exact ? " (similar title)" : ""}
                        </SelectItem>
                        <SelectItem value="new" className="text-xs">New document: "{item.parsed.title}"</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-6 sm:ml-0">
                  {statusBadge(item)}
                  {item.status === "failed" && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => intake.retry(item.id)}>
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />Retry
                    </Button>
                  )}
                  {(editable || item.status === "duplicate" || item.status === "failed") && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Remove from the list"
                      aria-label={`Remove ${item.file.name} from the list`}
                      onClick={() => intake.remove(item.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
