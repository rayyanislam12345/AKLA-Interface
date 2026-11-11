import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Inbox, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadState } from "@/components/LoadState";
import { TransactionStatusBadge } from "@/components/TransactionStatusBadge";
import { TransactionRowSheet } from "@/components/TransactionRowSheet";
import { NewTransactionRowDialog } from "@/components/NewTransactionRowDialog";
import { useStaleAfterDays, useTransactionRows, useTrayCount, type TransactionRow } from "@/hooks/useTransactions";
import {
  AUTO_SOURCES,
  formatLongDate,
  formatUpdateStamp,
  groupByPerson,
  groupByProject,
  idleDays,
  isMovedToday,
  isStale,
  rowMatches,
} from "@/lib/transactions";

type View = "project" | "person" | "today" | "stale";
const VIEWS: { key: View; label: string }[] = [
  { key: "project", label: "By project" },
  { key: "person", label: "By person" },
  { key: "today", label: "Moved today" },
  { key: "stale", label: "Stale" },
];

/** The Latest update cell: the line, its stamp, and whether a machine wrote it or the row has gone quiet. */
function LatestUpdate({ row, staleAfter }: { row: TransactionRow; staleAfter: number }) {
  const latest = row.latest?.[0];
  const stale = isStale(row, staleAfter);
  return (
    <div className="space-y-1">
      <p className="text-sm">{row.latest_update || <span className="text-muted-foreground">No update yet</span>}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {row.latest_update_at && <span>{formatUpdateStamp(row.latest_update_at, latest?.author)}</span>}
        {AUTO_SOURCES.includes(row.updated_source) && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
            auto · {row.updated_source}
          </Badge>
        )}
        {stale && (
          <Badge variant="outline" className="h-4 border-amber-500/60 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">
            no movement for {idleDays(row)} days
          </Badge>
        )}
      </div>
    </div>
  );
}

function ProjectLine({ row }: { row: TransactionRow }) {
  return (
    <span className="text-xs text-muted-foreground">
      {row.client} ·{" "}
      {row.matter_id ? (
        <Link to={`/matters/${row.matter_id}`} className="underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
          {row.project}
        </Link>
      ) : (
        row.project
      )}
    </span>
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

  const emptyText = query.trim()
    ? "No rows match your search."
    : view === "today"
      ? "Nothing has moved today yet."
      : view === "stale"
        ? `Nothing has sat for more than ${staleAfter} days.`
        : rows?.length
          ? "No open rows. Turn on Show closed to see the rest."
          : "The sheet is empty. Add the first row.";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions Hub</h1>
          <p className="text-muted-foreground">
            {formatLongDate(new Date())} · {openCount} open deliverable{openCount === 1 ? "" : "s"}.{" "}
            <Link to="/matters" className="underline underline-offset-2">
              Projects
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {trayCount > 0 && (
            <Button asChild size="sm" variant="secondary" className="h-8">
              <Link to="/transactions/tray">
                <Inbox className="mr-1.5 h-4 w-4" />
                Needs a look · {trayCount}
              </Link>
            </Button>
          )}
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New row
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {VIEWS.map((v) => (
            <Button
              key={v.key}
              size="sm"
              variant={view === v.key ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search client, project, deliverable, team, update"
            aria-label="Search the sheet"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={showClosed} onCheckedChange={setShowClosed} aria-label="Show closed rows" />
          Show closed
        </label>
      </div>

      <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="the sheet" isEmpty={!visible.length} empty={emptyText}>
        {/* A table's columns can't shrink enough for a phone without
            horizontal scroll; a stacked card per row needs none. */}
        <div className="hidden sm:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Deliverable</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Currently with</TableHead>
                <TableHead className="w-[32%]">Latest update</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <GroupRows key={g.key} heading={g.heading} rows={g.rows} staleAfter={staleAfter} onOpen={setOpenRow} />
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-4 sm:hidden">
          {groups.map((g) => (
            <div key={g.key} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">{g.heading}</h2>
              {g.rows.map((row) => (
                <div key={row.id} className="cursor-pointer rounded-md border px-3 py-2.5" onClick={() => setOpenRow(row)}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{row.deliverable}</p>
                      <ProjectLine row={row} />
                    </div>
                    <TransactionStatusBadge status={row.status} className="shrink-0" />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[row.team?.length ? row.team.join(", ") : null, row.currently_with ? `with ${row.currently_with}` : null].filter(Boolean).join(" · ")}
                  </p>
                  <div className="mt-1.5">
                    <LatestUpdate row={row} staleAfter={staleAfter} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </LoadState>

      <TransactionRowSheet row={sheetRow} onClose={() => setOpenRow(null)} />
      <NewTransactionRowDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function GroupRows({ heading, rows, staleAfter, onOpen }: { heading: string; rows: TransactionRow[]; staleAfter: number; onOpen: (row: TransactionRow) => void }) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={5} className="py-1.5 text-xs font-medium text-muted-foreground">
          {heading}
        </TableCell>
      </TableRow>
      {rows.map((row) => (
        <TableRow key={row.id} className="cursor-pointer" onClick={() => onOpen(row)}>
          <TableCell className="align-top">
            <p className="font-medium">{row.deliverable}</p>
            <ProjectLine row={row} />
          </TableCell>
          <TableCell className="align-top text-sm">{row.team?.length ? row.team.join(", ") : <span className="text-muted-foreground">No one yet</span>}</TableCell>
          <TableCell className="align-top text-sm">{row.currently_with || <span className="text-muted-foreground">Not set</span>}</TableCell>
          <TableCell className="align-top">
            <LatestUpdate row={row} staleAfter={staleAfter} />
          </TableCell>
          <TableCell className="align-top">
            <TransactionStatusBadge status={row.status} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
