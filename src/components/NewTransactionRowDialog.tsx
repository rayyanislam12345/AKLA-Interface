import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TeamPicker } from "@/components/TeamPicker";
import { useProfiles } from "@/hooks/useProfiles";
import { useCreateTransactionRow } from "@/hooks/useTransactions";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { TRANSACTION_STATUSES } from "@/lib/transactions";

/** A new line on the sheet, added at the bottom. */
export function NewTransactionRowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: profiles } = useProfiles();
  const names = useMemo(() => (profiles ?? []).map((p) => p.full_name?.trim()).filter((n): n is string => !!n), [profiles]);
  const createRow = useCreateTransactionRow();
  const { toast } = useToast();
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [team, setTeam] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Not Started");
  const ready = !!client.trim() && !!project.trim() && !!deliverable.trim();

  const submit = async () => {
    if (!ready) return;
    try {
      await createRow.mutateAsync({ client, project, deliverable, team, status });
      toast({ title: "Row added", description: `${deliverable.trim()} is on the sheet.` });
      setClient("");
      setProject("");
      setDeliverable("");
      setTeam([]);
      setStatus("Not Started");
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Couldn't add the row", description: friendlyError(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New row</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-tx-client">Client</Label>
              <Input id="new-tx-client" value={client} onChange={(e) => setClient(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-tx-project">Project</Label>
              <Input id="new-tx-project" value={project} onChange={(e) => setProject(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-tx-deliverable">Deliverable</Label>
            <Input id="new-tx-deliverable" placeholder="e.g. Concession Agreement" value={deliverable} onChange={(e) => setDeliverable(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-tx-team">Team</Label>
            <TeamPicker id="new-tx-team" value={team} onChange={setTeam} options={names} />
          </div>
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || createRow.isPending}>
              {createRow.isPending ? "Adding…" : "Add row"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
