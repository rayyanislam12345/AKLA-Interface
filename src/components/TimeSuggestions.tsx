import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useConfirmTimeSuggestions, useDropTimeSuggestion, useMyTimeSuggestions, type TimeSuggestion } from "@/hooks/useTransactions";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { formatShortDate } from "@/lib/transactions";

const NO_PROJECT_NOTE = "No Hub project for this transaction yet, kept as a record";

/**
 * Hours the intake read from the person's own agenda, waiting for a yes.
 * Shown above the timesheet only while there are some; a confirmed line with
 * a Hub project lands in the timesheet below.
 */
export function TimeSuggestions() {
  const { user } = useAuth();
  const { data: suggestions } = useMyTimeSuggestions(user?.id);
  const confirm = useConfirmTimeSuggestions();
  const drop = useDropTimeSuggestion();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!suggestions?.length) return null;
  const withProject = suggestions.filter((s) => !!s.matter_id);

  const confirmOne = async (s: TimeSuggestion) => {
    setBusyId(s.id);
    try {
      const { recorded } = await confirm.mutateAsync([s]);
      toast(recorded ? { title: "Hours confirmed", description: `${s.hours} h on ${s.transaction} is in your timesheet.` } : { title: "Hours confirmed", description: NO_PROJECT_NOTE });
    } catch (e) {
      toast({ title: "Couldn't confirm the hours", description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const confirmAll = async () => {
    try {
      const { recorded } = await confirm.mutateAsync(withProject);
      toast({ title: "Hours confirmed", description: `${recorded} line${recorded === 1 ? "" : "s"} added to your timesheet.` });
    } catch (e) {
      toast({ title: "Couldn't confirm the hours", description: friendlyError(e), variant: "destructive" });
    }
  };

  const dropOne = async (s: TimeSuggestion) => {
    setBusyId(s.id);
    try {
      await drop.mutateAsync(s);
    } catch (e) {
      toast({ title: "Couldn't drop it", description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">My hours to confirm</CardTitle>
          <p className="text-sm text-muted-foreground">Read from your daily agenda. Confirm what is right; drop what is not.</p>
        </div>
        {withProject.length > 1 && (
          <Button size="sm" onClick={confirmAll} disabled={confirm.isPending}>
            Confirm all ({withProject.length})
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-0 pb-2 sm:px-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead>Narrative</TableHead>
              <TableHead className="text-right">Hours</TableHead>
              <TableHead className="text-right">Billable</TableHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {suggestions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="whitespace-nowrap align-top text-sm">{formatShortDate(`${s.work_date}T12:00:00+05:00`)}</TableCell>
                <TableCell className="align-top text-sm">
                  {s.transaction}
                  {!s.matter_id && <p className="text-xs text-muted-foreground">No Hub project yet</p>}
                </TableCell>
                <TableCell className="align-top text-sm">{s.narrative}</TableCell>
                <TableCell className="align-top text-right text-sm">{Number(s.hours)}</TableCell>
                <TableCell className="align-top text-right text-sm">{s.billable_hours === null ? "" : Number(s.billable_hours)}</TableCell>
                <TableCell className="align-top">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => confirmOne(s)} disabled={busyId === s.id || confirm.isPending}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => dropOne(s)} disabled={busyId === s.id || drop.isPending}>
                      Drop
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
