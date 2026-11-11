import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadState } from "@/components/LoadState";
import { TransactionRowPicker } from "@/components/TransactionRowPicker";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { formatLongDate, formatShortDate, isOpenStatus, readTrayItem, type TrayItemView } from "@/lib/transactions";
import {
  useAcceptAgendaLine,
  useDropTrayItem,
  useOpenTray,
  useResolveExcelConflict,
  useTransactionRows,
  type TransactionRow,
  type TrayItem,
} from "@/hooks/useTransactions";

const KIND_TITLES: Record<string, string> = {
  agenda_line_no_row: "Agenda line with no row",
  agenda_line_unsure: "Agenda line, not sure which row",
  excel_conflict: "Both changed",
  time_no_row: "Hours with no row",
  agenda_unreadable: "Agenda the Hub couldn't read",
};

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      {value}
    </p>
  );
}

function DraftRow({ v }: { v: TrayItemView }) {
  if (!v.guessNewRow) return null;
  const d = v.guessNewRow;
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <p className="text-xs text-muted-foreground">Drafted row</p>
      <p className="font-medium">{d.deliverable || v.deliverable || "Deliverable"}</p>
      <p className="text-xs text-muted-foreground">
        {[d.client || "Client", d.project || v.transaction || "Project"].join(" · ")}
        {d.team.length ? ` · ${d.team.join(", ")}` : ""}
      </p>
    </div>
  );
}

interface CardProps {
  item: TrayItem;
  rowsById: Map<string, TransactionRow>;
  busy: boolean;
  onAdd: () => void;
  onAccept: (rowId: string) => void;
  onPick: () => void;
  onDrop: () => void;
  onKeep: (keep: "hub" | "excel") => void;
}

/** One tray item, worded by kind, with the buttons that clear it. */
function TrayCard({ item, rowsById, busy, onAdd, onAccept, onPick, onDrop, onKeep }: CardProps) {
  const v = readTrayItem(item);
  const guessed = v.guessRowId ? rowsById.get(v.guessRowId) : undefined;
  const conflictRow = v.rowId ? rowsById.get(v.rowId) : undefined;
  const kind = item.kind;

  const title = (() => {
    switch (kind) {
      case "agenda_line_no_row":
      case "agenda_line_unsure":
        return `${KIND_TITLES[kind]} · ${[v.person, [v.transaction, v.deliverable].filter(Boolean).join(" / ")].filter(Boolean).join(": ")}`;
      case "excel_conflict":
        return `Both changed · ${v.field || "a cell"} on ${conflictRow?.deliverable || v.deliverable || "a row"}`;
      case "time_no_row":
        return `Hours with no row · ${[v.person, v.date ? formatShortDate(v.date) : "", v.hours ? `${v.hours} h` : ""].filter(Boolean).join(", ")}${v.transaction ? ` on ${v.transaction}` : ""}`;
      case "agenda_unreadable":
        return `${KIND_TITLES[kind]} · ${v.file || "a file"}`;
      default:
        return KIND_TITLES[kind] ?? kind;
    }
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Arrived {formatLongDate(item.created_at)}
          {v.file && kind !== "agenda_unreadable" ? ` · ${v.file}` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {kind === "agenda_line_unsure" && (
          <p className="text-sm">
            <span className="text-muted-foreground">Probably: </span>
            {guessed ? (
              <>
                <span className="font-medium">{guessed.deliverable}</span> ({guessed.client} · {guessed.project})
              </>
            ) : (
              "a row the Hub can no longer find"
            )}
          </p>
        )}
        {(kind === "agenda_line_no_row" || kind === "agenda_line_unsure") && (
          <>
            <Field label="Scope of Task" value={v.scope} />
            <DraftRow v={v} />
          </>
        )}
        {kind === "excel_conflict" && (
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">The sheet says</p>
              <p>{v.sheetValue || "(blank)"}</p>
            </div>
            <div className="rounded-md border px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">The Hub says</p>
              <p>{v.hubValue || "(blank)"}</p>
            </div>
            <div className="rounded-md border px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">Before either</p>
              <p>{v.beforeValue || "(blank)"}</p>
            </div>
          </div>
        )}
        {kind === "time_no_row" && <Field label="Narrative" value={v.scope} />}
        {kind === "agenda_unreadable" && (
          <>
            <Field label="File" value={v.file} />
            <Field label="Problem" value={v.error || "The parser gave no reason."} />
          </>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {kind === "agenda_line_no_row" && (
            <>
              <Button size="sm" onClick={onAdd} disabled={busy || !v.guessNewRow}>
                Add the row
              </Button>
              <Button size="sm" variant="outline" onClick={onPick} disabled={busy}>
                It's this row…
              </Button>
            </>
          )}
          {kind === "agenda_line_unsure" && (
            <>
              <Button size="sm" onClick={() => onAccept(v.guessRowId)} disabled={busy || !guessed}>
                Yes, that row
              </Button>
              <Button size="sm" variant="outline" onClick={onPick} disabled={busy}>
                Another row…
              </Button>
            </>
          )}
          {kind === "excel_conflict" && (
            <>
              <Button size="sm" onClick={() => onKeep("hub")} disabled={busy}>
                Keep the Hub's
              </Button>
              <Button size="sm" variant="outline" onClick={() => onKeep("excel")} disabled={busy || !v.rowId}>
                Take the sheet's
              </Button>
            </>
          )}
          {kind === "time_no_row" && (
            <Button size="sm" onClick={onPick} disabled={busy}>
              It's this row…
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDrop} disabled={busy}>
            Drop
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function IntakeTrayPage() {
  const { data: items, isLoading, error, refetch } = useOpenTray();
  const { data: rows } = useTransactionRows();
  const accept = useAcceptAgendaLine();
  const resolveConflict = useResolveExcelConflict();
  const drop = useDropTrayItem();
  const { toast } = useToast();
  const [pickFor, setPickFor] = useState<TrayItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rowsById = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const openRows = useMemo(() => (rows ?? []).filter((r) => isOpenStatus(r.status)), [rows]);

  const run = async (item: TrayItem, work: () => Promise<unknown>, done: string, failed: string) => {
    setBusyId(item.id);
    try {
      await work();
      toast({ title: done });
    } catch (e) {
      toast({ title: failed, description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const count = items?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/transactions" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Transactions Hub
        </Link>
        <h1 className="text-2xl font-semibold">Needs a look{count ? ` · ${count}` : ""}</h1>
        <p className="text-muted-foreground">
          What the agendas and the sheet brought in that the Hub could not place on its own. Oldest first.
        </p>
      </div>

      <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="the tray" isEmpty={!count} empty="Nothing needs a look. Everything that arrived found its row.">
        <div className="space-y-3">
          {items?.map((item) => (
            <TrayCard
              key={item.id}
              item={item}
              rowsById={rowsById}
              busy={busyId === item.id}
              onAdd={() => run(item, () => accept.mutateAsync({ item }), "Row added to the sheet", "Couldn't add the row")}
              onAccept={(rowId) => run(item, () => accept.mutateAsync({ item, rowId }), "Line placed on the row", "Couldn't place the line")}
              onPick={() => setPickFor(item)}
              onDrop={() => run(item, () => drop.mutateAsync(item), "Dropped", "Couldn't drop it")}
              onKeep={(keep) =>
                run(item, () => resolveConflict.mutateAsync({ item, keep }), keep === "hub" ? "Kept the Hub's value" : "Took the sheet's value", "Couldn't settle it")
              }
            />
          ))}
        </div>
      </LoadState>

      <TransactionRowPicker
        open={!!pickFor}
        onOpenChange={(open) => !open && setPickFor(null)}
        rows={openRows}
        onPick={(row) => {
          const item = pickFor;
          if (!item) return;
          void run(item, () => accept.mutateAsync({ item, rowId: row.id }), `Placed on ${row.deliverable}`, "Couldn't place the line");
        }}
      />
    </div>
  );
}
