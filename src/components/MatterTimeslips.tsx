import { useMemo, useState } from "react";
import { Clock, Download, Loader2, Pencil } from "lucide-react";
import {
  MatterTimeslip,
  RANGE_LABELS,
  RangePreset,
  TimeslipEdits,
  authorName,
  byTask,
  resolveRange,
  summarise,
  useMatterTimeslips,
  useUpdateTimeslip,
} from "@/hooks/useMatterTimeslips";
import { useMatterTasks } from "@/hooks/useMatterDetail";
import { useAuth } from "@/hooks/useAuth";
import { useProfiles } from "@/hooks/useProfiles";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type View = "entries" | "day" | "author" | "task";

const VIEWS: { key: View; label: string }[] = [
  { key: "entries", label: "Entries" },
  { key: "day", label: "By day" },
  { key: "task", label: "By task" },
  { key: "author", label: "By associate" },
];

const PRESETS: RangePreset[] = ["today", "7", "30", "90", "all"];

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function toCsv(slips: MatterTimeslip[], matterName: string) {
  const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Date", "Associate", "Hours", "Task code", "Narrative", "Matter"].join(","),
    ...slips.map((s) =>
      [
        s.work_date,
        esc(authorName(s)),
        Number(s.hours).toFixed(1),
        esc(s.task_code ?? ""),
        esc(s.task?.title ?? ""),
        esc(s.narrative),
        esc(matterName),
      ].join(",")
    ),
  ];
  // BOM so Excel reads the accented party names correctly.
  return "﻿" + rows.join("\n");
}

// Keyed by slip.id from the caller so each open resets its own state instead
// of carrying over the previous slip's edits.
function EditTimeslipDialog({
  slip,
  matterId,
  tasks,
  onClose,
}: {
  slip: MatterTimeslip;
  matterId: string;
  tasks: { id: string; title: string }[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const updateTimeslip = useUpdateTimeslip();

  const [workDate, setWorkDate] = useState(slip.work_date);
  const [hours, setHours] = useState(String(slip.hours));
  const [taskCode, setTaskCode] = useState(slip.task_code ?? "");
  const [narrative, setNarrative] = useState(slip.narrative);
  const [hubTaskId, setHubTaskId] = useState(slip.hub_task_id ?? "none");

  const hoursValue = Number(hours);
  const canSave = workDate && hoursValue > 0 && narrative.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    const edits: TimeslipEdits = {
      work_date: workDate,
      hours: hoursValue,
      task_code: taskCode.trim() || null,
      narrative: narrative.trim(),
      hub_task_id: hubTaskId === "none" ? null : hubTaskId,
    };
    try {
      await updateTimeslip.mutateAsync({ id: slip.id, matterId, edits });
      toast({ title: "Timeslip updated" });
      onClose();
    } catch (err: any) {
      toast({ title: "Failed to update timeslip", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Timeslip</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Associate: <span className="font-medium text-foreground">{authorName(slip)}</span> (not editable)
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-timeslip-date">Date</Label>
              <Input
                id="edit-timeslip-date"
                type="date"
                value={workDate}
                onChange={(e) => setWorkDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-timeslip-hours">Hours</Label>
              <Input
                id="edit-timeslip-hours"
                type="number"
                step="0.1"
                min="0.1"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Task</Label>
            <Select value={hubTaskId} onValueChange={setHubTaskId}>
              <SelectTrigger>
                <SelectValue placeholder="No task" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No task</SelectItem>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-timeslip-code">Task code</Label>
            <Input
              id="edit-timeslip-code"
              placeholder="e.g. L110"
              value={taskCode}
              onChange={(e) => setTaskCode(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-timeslip-narrative">Narrative</Label>
            <Textarea
              id="edit-timeslip-narrative"
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              className="min-h-24"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || updateTimeslip.isPending}>
            {updateTimeslip.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MatterTimeslips({
  matterId,
  matterName,
}: {
  matterId: string;
  matterName: string;
}) {
  const [preset, setPreset] = useState<RangePreset>("30");
  const [view, setView] = useState<View>("entries");
  const [editing, setEditing] = useState<MatterTimeslip | null>(null);
  const range = useMemo(() => resolveRange(preset), [preset]);
  const { data: slips, isLoading, error } = useMatterTimeslips(matterId, range);
  const { data: tasks } = useMatterTasks(matterId);
  const { user } = useAuth();
  const { data: profiles } = useProfiles();

  // Matches the RLS policy exactly: the author, or an admin/partner
  // correcting someone else's entry.
  const currentRole = profiles?.find((p) => p.id === user?.id)?.role;
  const isPrivileged = currentRole === "admin" || currentRole === "partner";
  const canEdit = (s: MatterTimeslip) => isPrivileged || s.author_id === user?.id;

  const { total, byDay, byAuthor } = useMemo(
    () => summarise(slips ?? []),
    [slips]
  );

  const download = () => {
    const blob = new Blob([toCsv(slips ?? [], matterName)], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timeslips-${matterName.replace(/[^\w-]+/g, "-")}-${preset}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const grouped =
    view === "day" ? byDay : view === "task" ? byTask(slips ?? []) : byAuthor;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Timeslips
        </CardTitle>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium tabular-nums">
            {total.toFixed(1)} h
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={download}
            disabled={!slips?.length}
          >
            <Download className="h-4 w-4 mr-1.5" />
            CSV
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setPreset(p)}
            >
              {RANGE_LABELS[p]}
            </Button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {VIEWS.map((v) => (
            <Button
              key={v.key}
              size="sm"
              variant={view === v.key ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setView(v.key)}
            >
              {v.label}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading time entries…
          </div>
        ) : error ? (
          // Showing the empty state on a failed query makes "no data" and
          // "broken query" look identical, which hides exactly the problem
          // you need to see.
          <div className="py-6 text-sm">
            <p className="font-medium text-destructive">
              Could not load time entries.
            </p>
            <p className="mt-1 text-muted-foreground">
              {(error as Error)?.message ?? "Unknown error"}
            </p>
          </div>
        ) : !slips?.length ? (
          <p className="py-6 text-sm text-muted-foreground">
            No time recorded against this matter in this period. Associates
            upload approved entries from Timekeeper.
          </p>
        ) : view === "entries" ? (
          <>
            {/* A 7-column table can't shrink to fit a phone — a stacked
                card per entry needs no horizontal scroll at all. */}
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Date</TableHead>
                    <TableHead className="w-[150px]">Associate</TableHead>
                    <TableHead className="w-[64px] text-right">Hours</TableHead>
                    <TableHead className="w-[70px]">Code</TableHead>
                    <TableHead>Narrative</TableHead>
                    <TableHead className="w-[150px]">Task</TableHead>
                    <TableHead className="w-8"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {slips.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDate(s.work_date)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {authorName(s)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {Number(s.hours).toFixed(1)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {s.task_code ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">{s.narrative}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.task?.title ?? "—"}
                      </TableCell>
                      <TableCell>
                        {canEdit(s) && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(s)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="sm:hidden space-y-2">
              {slips.map((s) => (
                <div key={s.id} className="border rounded-md px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {formatDate(s.work_date)}{" "}
                        <span className="font-normal text-muted-foreground">· {authorName(s)}</span>
                      </p>
                      {(s.task?.title || s.task_code) && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {[s.task?.title, s.task_code].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-sm font-medium tabular-nums">{Number(s.hours).toFixed(1)}h</span>
                      {canEdit(s) && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(s)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-sm mt-1.5">{s.narrative}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {view === "day"
                        ? "Date"
                        : view === "task"
                        ? "Task"
                        : "Associate"}
                    </TableHead>
                    <TableHead className="w-[90px] text-right">Hours</TableHead>
                    <TableHead className="w-[45%]">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...grouped.entries()]
                    .sort((a, b) =>
                      view === "day"
                        ? b[0].localeCompare(a[0])
                        : b[1] - a[1]
                    )
                    .map(([key, hours]) => (
                      <TableRow key={key}>
                        <TableCell className="whitespace-nowrap">
                          {view === "day" ? formatDate(key) : key}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {hours.toFixed(1)}
                        </TableCell>
                        <TableCell>
                          <div className="h-2 w-full rounded bg-muted">
                            <div
                              className={cn("h-2 rounded bg-primary")}
                              style={{
                                width: `${total ? (hours / total) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>

            <div className="sm:hidden space-y-2">
              {[...grouped.entries()]
                .sort((a, b) => (view === "day" ? b[0].localeCompare(a[0]) : b[1] - a[1]))
                .map(([key, hours]) => (
                  <div key={key} className="border rounded-md px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm truncate">{view === "day" ? formatDate(key) : key}</p>
                      <span className="text-sm font-medium tabular-nums shrink-0">{hours.toFixed(1)}h</span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-muted mt-1.5">
                      <div
                        className="h-1.5 rounded bg-primary"
                        style={{ width: `${total ? (hours / total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </CardContent>

      {editing && (
        <EditTimeslipDialog
          key={editing.id}
          slip={editing}
          matterId={matterId}
          tasks={tasks ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
