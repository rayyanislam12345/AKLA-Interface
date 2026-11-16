import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, History, Inbox, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LoadState } from "@/components/LoadState";
import { TransactionStatusDot } from "@/components/TransactionStatusBadge";
import { TransactionRowSheet } from "@/components/TransactionRowSheet";
import { TimelineDialog } from "@/components/TransactionTimeline";
import { NewTransactionRowDialog } from "@/components/NewTransactionRowDialog";
import { useStaleAfterDays, useTransactionRows, useTrayCount, type TransactionRow } from "@/hooks/useTransactions";
import { cn } from "@/lib/utils";
import {
  formatShortDate,
  formatUpdateStamp,
  groupByPerson,
  groupByProject,
  idleDays,
  isMovedToday,
  isStale,
  rowMatches,
  type RowGroup,
} from "@/lib/transactions";

type View = "project" | "person" | "today" | "stale";
const VIEWS: { key: View; label: string }[] = [
  { key: "project", label: "By project" },
  { key: "person", label: "By person" },
  { key: "today", label: "Moved today" },
  { key: "stale", label: "Stale" },
];

interface TimelineTarget {
  title: string;
  subtitle?: string;
  rowIds: string[];
  showRow: boolean;
}

// One line per row: what it is, who has it, where it stands, when it last moved.
const COLS = "sm:grid sm:grid-cols-[minmax(0,1fr)_11rem_10.5rem_4rem] sm:items-center sm:gap-4";

interface RowLineProps {
  row: TransactionRow;
  open: boolean;
  staleAfter: number;
  /** Name the project on the line (the By person view, where the heading is a name). */
  showProject: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onTimeline: () => void;
}

/** A row of the sheet as one quiet line; clicking it unfolds the latest update and the two actions. */
function RowLine({ row, open, staleAfter, showProject, onToggle, onOpen, onTimeline }: RowLineProps) {
  const stale = isStale(row, staleAfter);
  const when = row.latest_update_at ? formatShortDate(row.latest_update_at) : "";
  const team = (row.team ?? []).filter(Boolean);
  return (
    <li className={cn("rounded-md", open && "bg-muted/40")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cn("w-full rounded-md px-3 py-2 text-left hover:bg-muted/40", COLS)}>
        <span className={cn("block min-w-0 text-sm", open ? "font-medium" : "truncate")}>
          {row.deliverable}
          {showProject && <span className="font-normal text-muted-foreground"> · {row.project}</span>}
        </span>
        <span className="hidden truncate text-sm text-muted-foreground sm:block">{row.currently_with && row.currently_with !== "-" ? row.currently_with : ""}</span>
        <span className="mt-0.5 flex items-center justify-between gap-3 sm:contents">
          <TransactionStatusDot status={row.status} />
          <span
            className={cn("shrink-0 text-xs tabular-nums sm:text-right", stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}
            title={stale ? `No movement for ${idleDays(row)} days` : undefined}
          >
            {when}
          </span>
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 pt-1">
          {row.latest_update ? (
            <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{row.latest_update}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No update yet.</p>
          )}
          <p className="text-xs text-muted-foreground">
            {[
              row.latest_update_at ? formatUpdateStamp(row.latest_update_at, row.latest?.[0]?.author) : "",
              team.length ? `Team: ${team.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("  ·  ")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={onOpen}>
              Update
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={onTimeline}>
              <History className="mr-1.5 h-3.5 w-3.5" />
              Timeline
            </Button>
            {row.matter_id && (
              <Link to={`/matters/${row.matter_id}`} className="ml-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Open project
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function TransactionsPage() {
  const { data: rows, isLoading, error, refetch } = useTransactionRows();
  const { data: staleAfter = 10 } = useStaleAfterDays();
  const { data: trayCount = 0 } = useTrayCount();
  const [view, setView] = useState<View>("project");
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [openRow, setOpenRow] = useState<TransactionRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineTarget | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const openCount = (rows ?? []).filter((r) => r.status !== "Closed").length;

  const visible = useMemo(() => {
    const now = new Date();
    return (rows ?? []).filter((r) => {
      if (!showClosed && r.status === "Closed") return false;
      if (!rowMatches(r, query)) return false;
      if (view === "today") return isMovedToday(r, now);
      if (view === "stale") return isStale(r, staleAfter, now);
      return true;
    });
  }, [rows, showClosed, query, view, staleAfter]);

  const groups = useMemo(() => (view === "person" ? groupByPerson(visible) : groupByProject(visible)), [visible, view]);

  // The sheet shows the row as it is now, not as it was when clicked.
  const sheetRow = openRow ? (rows ?? []).find((r) => r.id === openRow.id) ?? openRow : null;

  const toggleFold = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groupTimeline = (g: RowGroup<TransactionRow>): TimelineTarget => ({
    title: g.heading,
    subtitle: view === "person" ? `Every row ${g.heading} is on, newest first.` : "Every deliverable on this project, newest first.",
    rowIds: g.rows.map((r) => r.id),
    showRow: true,
  });

  const emptyText = query.trim()
    ? "No rows match your search."
    : view === "today"
      ? "Nothing has moved today yet."
      : view === "stale"
        ? `Nothing has sat for more than ${staleAfter} days.`
        : rows?.length
          ? "No open rows. Turn on Closed to see the rest."
          : "The sheet is empty. Add the first row.";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <span className="text-sm text-muted-foreground">{openCount} open</span>
        </div>
        <div className="flex items-center gap-2">
          {trayCount > 0 && (
            <Button asChild size="sm" variant="ghost" className="h-8">
              <Link to="/transactions/tray">
                <Inbox className="mr-1.5 h-4 w-4" />
                Needs a look · {trayCount}
              </Link>
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New row
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          {VIEWS.map((v) => (
            <Button
              key={v.key}
              size="sm"
              variant={view === v.key ? "secondary" : "ghost"}
              className={cn("h-7 px-2.5 text-xs", view !== v.key && "text-muted-foreground")}
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search the sheet" className="h-8 pl-8" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showClosed} onCheckedChange={setShowClosed} aria-label="Show closed rows" className="scale-90" />
          Closed
        </label>
      </div>

      <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="the sheet" isEmpty={!visible.length} empty={emptyText}>
        <div className="space-y-6">
          <div className={cn("hidden px-3 text-xs text-muted-foreground", COLS)} aria-hidden>
            <span>Deliverable</span>
            <span>With</span>
            <span>Status</span>
            <span className="text-right">Moved</span>
          </div>
          {groups.map((g) => {
            const closed = folded.has(g.key);
            return (
              <section key={g.key} className="-mt-2">
                <div className="group flex items-center gap-1 border-b pb-1">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left" onClick={() => toggleFold(g.key)} aria-expanded={!closed}>
                    {closed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <h2 className="truncate text-sm font-semibold">{g.heading}</h2>
                    <span className="shrink-0 text-xs text-muted-foreground">{g.rows.length}</span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-muted-foreground sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                    onClick={() => setTimeline(groupTimeline(g))}
                  >
                    <History className="mr-1 h-3.5 w-3.5" />
                    Timeline
                  </Button>
                </div>
                {!closed && (
                  <ul className="mt-1">
                    {g.rows.map((row) => (
                      <RowLine
                        key={row.id}
                        row={row}
                        open={expanded === `${g.key}/${row.id}`}
                        staleAfter={staleAfter}
                        showProject={view === "person"}
                        onToggle={() => setExpanded((cur) => (cur === `${g.key}/${row.id}` ? null : `${g.key}/${row.id}`))}
                        onOpen={() => setOpenRow(row)}
                        onTimeline={() => setTimeline({ title: row.deliverable, subtitle: `${row.client} · ${row.project}`, rowIds: [row.id], showRow: false })}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </LoadState>

      <TransactionRowSheet row={sheetRow} onClose={() => setOpenRow(null)} />
      <TimelineDialog open={!!timeline} onOpenChange={(open) => !open && setTimeline(null)} title={timeline?.title ?? ""} subtitle={timeline?.subtitle} rowIds={timeline?.rowIds ?? []} showRow={timeline?.showRow ?? false} />
      <NewTransactionRowDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
