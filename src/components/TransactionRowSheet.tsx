import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadState } from "@/components/LoadState";
import { TeamPicker } from "@/components/TeamPicker";
import { TransactionStatusBadge } from "@/components/TransactionStatusBadge";
import { useProfiles } from "@/hooks/useProfiles";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { AUTO_SOURCES, TRANSACTION_STATUSES, changeLines, formatUpdateStampLong } from "@/lib/transactions";
import {
  useAddTransactionUpdate,
  useEditTransactionRow,
  useTransactionUpdates,
  type RowEdits,
  type TransactionRow,
} from "@/hooks/useTransactions";

interface TransactionRowSheetProps {
  row: TransactionRow | null;
  onClose: () => void;
}

/** The full history of one row, newest first, each line with where it came from. */
function UpdateHistory({ rowId }: { rowId: string }) {
  const { data: updates, isLoading, error, refetch } = useTransactionUpdates(rowId);
  return (
    <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="updates" compact isEmpty={!updates?.length} empty="No updates on this row yet.">
      <ol className="space-y-3">
        {updates?.map((u) => (
          <li key={u.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{formatUpdateStampLong(u.at, u.author)}</span>
              <Badge variant={AUTO_SOURCES.includes(u.source) ? "secondary" : "outline"} className="h-4 px-1.5 text-[10px] font-normal" title={u.source_ref ?? undefined}>
                {u.source === "hub" ? "typed here" : u.source === "load" ? "from the sheet" : `auto · ${u.source}`}
              </Badge>
            </div>
            <p className="whitespace-pre-wrap">{u.body}</p>
          </li>
        ))}
      </ol>
    </LoadState>
  );
}

/**
 * One row of the sheet, opened from the table: every field, an "Add update"
 * box, and the row's whole history. A field edit leaves its own line in the
 * history so the Excel shows the move too.
 */
export function TransactionRowSheet({ row, onClose }: TransactionRowSheetProps) {
  const { data: profiles } = useProfiles();
  const names = useMemo(() => (profiles ?? []).map((p) => p.full_name?.trim()).filter((n): n is string => !!n), [profiles]);
  const addUpdate = useAddTransactionUpdate();
  const editRow = useEditTransactionRow();
  const { toast } = useToast();

  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string>("Not Started");
  const [currentlyWith, setCurrentlyWith] = useState("");
  const [team, setTeam] = useState<string[]>([]);
  const [deliverable, setDeliverable] = useState("");
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");

  // Seeded when a row opens, not on every refetch, so a background refresh
  // never wipes what is being typed.
  const openId = row?.id ?? null;
  useEffect(() => {
    if (!row) return;
    setNote("");
    setStatus(row.status);
    setCurrentlyWith(row.currently_with ?? "");
    setTeam(row.team ?? []);
    setDeliverable(row.deliverable);
    setClient(row.client);
    setProject(row.project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const edits: RowEdits = {
    status,
    currently_with: currentlyWith.trim() || null,
    team,
    deliverable: deliverable.trim(),
    client: client.trim(),
    project: project.trim(),
  };
  const pendingLine = row ? changeLines(row as unknown as Record<string, unknown>, edits as Record<string, unknown>) : "";
  const canSave = !!pendingLine && !!edits.deliverable && !!edits.client && !!edits.project;

  const saveNote = async () => {
    if (!row || !note.trim()) return;
    try {
      await addUpdate.mutateAsync({ rowId: row.id, body: note });
      setNote("");
      toast({ title: "Update added" });
    } catch (e) {
      toast({ title: "Couldn't add the update", description: friendlyError(e), variant: "destructive" });
    }
  };

  const saveEdits = async () => {
    if (!row || !canSave) return;
    try {
      await editRow.mutateAsync({ row, edits });
      toast({ title: "Row moved", description: pendingLine });
    } catch (e) {
      toast({ title: "Couldn't save the row", description: friendlyError(e), variant: "destructive" });
    }
  };

  return (
    <Sheet open={!!row} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {row && (
          <>
            <SheetHeader className="space-y-1 border-b px-6 py-4 text-left">
              <SheetTitle className="break-words text-base">{row.deliverable}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {row.client} ·{" "}
                  {row.matter_id ? (
                    <Link to={`/matters/${row.matter_id}`} className="underline underline-offset-2">
                      {row.project}
                    </Link>
                  ) : (
                    row.project
                  )}
                </span>
                <TransactionStatusBadge status={row.status} />
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-6 py-5">
              <section className="space-y-2">
                <Label htmlFor="tx-note">Add update</Label>
                <Textarea
                  id="tx-note"
                  rows={3}
                  placeholder="What happened on this deliverable"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={saveNote} disabled={!note.trim() || addUpdate.isPending}>
                    {addUpdate.isPending ? "Adding…" : "Add update"}
                  </Button>
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-sm font-medium">Move the row</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select value={status} onValueChange={setStatus}>
                      <SelectTrigger aria-label="Status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRANSACTION_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tx-with">Currently with</Label>
                    <Input id="tx-with" placeholder="Boss, the client, a name" value={currentlyWith} onChange={(e) => setCurrentlyWith(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tx-team">Team</Label>
                  <TeamPicker id="tx-team" value={team} onChange={setTeam} options={names} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tx-deliverable">Deliverable</Label>
                  <Input id="tx-deliverable" value={deliverable} onChange={(e) => setDeliverable(e.target.value)} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="tx-client">Client</Label>
                    <Input id="tx-client" value={client} onChange={(e) => setClient(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tx-project">Project</Label>
                    <Input id="tx-project" value={project} onChange={(e) => setProject(e.target.value)} />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">{pendingLine || "Nothing changed yet."}</p>
                  <Button size="sm" onClick={saveEdits} disabled={!canSave || editRow.isPending}>
                    {editRow.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">History</h3>
                <UpdateHistory rowId={row.id} />
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
