import { useMemo, useState } from "react";
import { ArrowRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadState } from "@/components/LoadState";
import { TransactionStatusBadge } from "@/components/TransactionStatusBadge";
import { cn } from "@/lib/utils";
import { AUTO_SOURCES, groupByDay, mergeSameLines, parseChangeLine, zonedTime } from "@/lib/transactions";
import { useTransactionTimeline, type TimelineUpdate } from "@/hooks/useTransactions";

type Filter = "all" | "moves" | "notes";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "moves", label: "Moves only" },
  { key: "notes", label: "Notes only" },
];

const LONG = 220;

function sourceLabel(source: string): string {
  return `auto, from the ${source === "excel" ? "sheet" : source}`;
}

/** A field change as chips: "Status  With Boss → With Client". */
function ChangeChips({ parts }: { parts: NonNullable<ReturnType<typeof parseChangeLine>> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex flex-wrap items-center gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{p.label}</span>
          {p.field === "status" ? (
            <>
              {p.was && <TransactionStatusBadge status={p.was} className="opacity-60" />}
              {p.was && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
              {p.now ? <TransactionStatusBadge status={p.now} /> : <span className="italic text-muted-foreground">cleared</span>}
            </>
          ) : (
            <>
              {p.was && <span className="text-muted-foreground line-through">{p.was}</span>}
              {p.was && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
              {p.now ? <span>{p.now}</span> : <span className="italic text-muted-foreground">cleared</span>}
            </>
          )}
        </span>
      ))}
    </div>
  );
}

/** One note, clipped when long, with a "More" that opens it. */
function NoteBody({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const long = body.length > LONG;
  return (
    <div>
      <p className={cn("whitespace-pre-wrap text-sm leading-relaxed", !open && long && "line-clamp-3")}>{body}</p>
      {long && (
        <button type="button" className="mt-0.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpen((v) => !v)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

interface TimelineProps {
  updates: TimelineUpdate[];
  /** Name the row on each entry (a project's or a person's timeline). */
  showRow?: boolean;
  filter?: Filter;
}

/** A vertical timeline: one heading per day, a dot per entry, moves drawn as chips and notes as text. */
export function Timeline({ updates, showRow = false, filter = "all" }: TimelineProps) {
  const shown = useMemo(
    () =>
      updates.filter((u) => {
        if (filter === "all") return true;
        const change = !!parseChangeLine(u.body);
        return filter === "moves" ? change : !change;
      }),
    [updates, filter],
  );
  const days = useMemo(() => groupByDay(shown), [shown]);

  if (!shown.length) {
    return <p className="text-sm text-muted-foreground">{filter === "all" ? "Nothing on the timeline yet." : "Nothing of that kind yet."}</p>;
  }

  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day.key}>
          <h4 className="sticky top-0 z-10 -mx-1 mb-2 bg-background/95 px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
            {day.label}
          </h4>
          <ol className="relative ml-1 border-l border-border pl-5">
            {mergeSameLines(day.items, (u) => u.row?.deliverable ?? "").map(({ item: u, rows }) => {
              const parts = parseChangeLine(u.body);
              const auto = AUTO_SOURCES.includes(u.source);
              const where = rows.length > 1 ? `${rows.length} deliverables` : rows[0];
              return (
                <li key={u.id} className="relative pb-4 last:pb-0">
                  <span className={cn("absolute -left-[24px] top-1.5 h-2 w-2 rounded-full", parts ? "bg-primary" : "bg-border")} aria-hidden />
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">{zonedTime(u.at)}</span>
                    {u.author && <span className="text-foreground">{u.author}</span>}
                    {auto && <span title={u.source_ref ?? undefined}>{sourceLabel(u.source)}</span>}
                    {showRow && where && (
                      <span className="truncate" title={rows.length > 1 ? rows.join("\n") : undefined}>
                        {where}
                      </span>
                    )}
                  </div>
                  <div className="mt-1">{parts ? <ChangeChips parts={parts} /> : <NoteBody body={u.body} />}</div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

interface TimelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  rowIds: string[];
  showRow?: boolean;
}

/** The timeline of one row, or of every row in a project or under a person, in a dialog with its filters. */
export function TimelineDialog({ open, onOpenChange, title, subtitle, rowIds, showRow = false }: TimelineDialogProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const { data: updates, isLoading, error, refetch } = useTransactionTimeline(rowIds, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-1 border-b px-6 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="break-words">{title}</span>
          </DialogTitle>
          <DialogDescription>{subtitle || `${rowIds.length} row${rowIds.length === 1 ? "" : "s"}, newest first.`}</DialogDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {FILTERS.map((f) => (
              <Button key={f.key} size="sm" variant={filter === f.key ? "secondary" : "ghost"} className="h-7 px-2.5 text-xs" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </Button>
            ))}
          </div>
        </DialogHeader>
        <div className="overflow-y-auto px-6 py-4">
          <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="the timeline" compact isEmpty={!updates?.length} empty="Nothing on the timeline yet.">
            <Timeline updates={updates ?? []} showRow={showRow} filter={filter} />
          </LoadState>
        </div>
      </DialogContent>
    </Dialog>
  );
}
