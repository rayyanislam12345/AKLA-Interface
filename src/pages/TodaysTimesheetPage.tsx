import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Download, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useMatters, type MatterListItem } from "@/hooks/useMatters";
import {
  MyTimeslip,
  MyTimeslipEdits,
  localISODate,
  parseLocalISODate,
  shiftISODate,
  useAddMyTimeslip,
  useDeleteMyTimeslip,
  useMyTimeslips,
  useReorderMyTimeslips,
  useUpdateMyTimeslip,
} from "@/hooks/useMatterTimeslips";
import { buildTimesheetDocxBlob } from "@/lib/timesheetDocx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

function roleLabel(role: string | null) {
  if (!role) return "Associate";
  // Every role reads fine capitalizing just the first letter, except
  // "senior_counsel" — split on underscore and title-case each word so
  // that one doesn't render as "Senior_counsel".
  return role
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function dateLabel(isoDate: string) {
  return parseLocalISODate(isoDate).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "" -> null, otherwise the number (NaN if it isn't one). */
function optionalHours(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

interface AddEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workDate: string;
  matters: MatterListItem[] | undefined;
  onAdd: (entry: {
    matterId: string;
    hours: number;
    narrative: string;
    billableHours: number | null;
    akBillableHours: number | null;
  }) => Promise<boolean>;
}

// "Add entry": the same fields a row already has (project, description,
// hours, billable, AK billable), for time not uploaded from Timekeeper — a
// hearing, a client meeting, work done on a Mac or a phone.
function AddEntryDialog({ open, onOpenChange, workDate, matters, onAdd }: AddEntryDialogProps) {
  const [matterId, setMatterId] = useState("");
  const [hours, setHours] = useState("");
  const [narrative, setNarrative] = useState("");
  const [billableHours, setBillableHours] = useState("");
  const [akBillableHours, setAkBillableHours] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activeMatters = useMemo(
    () =>
      (matters ?? [])
        .filter((m) => (m.status ?? "").trim().toLowerCase() === "active")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [matters]
  );

  useEffect(() => {
    if (open) {
      setMatterId("");
      setHours("");
      setNarrative("");
      setBillableHours("");
      setAkBillableHours("");
      setProblem(null);
    }
  }, [open]);

  const submit = async () => {
    const h = Number(hours);
    const billable = optionalHours(billableHours);
    const akBillable = optionalHours(akBillableHours);
    if (!matterId) return setProblem("Choose the project this time was spent on.");
    if (!hours.trim() || !Number.isFinite(h) || h <= 0) return setProblem("Enter the hours worked, more than 0.");
    if (h > 24) return setProblem("One entry can't be more than 24 hours.");
    if (!narrative.trim()) return setProblem("Describe the work in a few words.");
    if (billable !== null && (!Number.isFinite(billable) || billable < 0 || billable > h))
      return setProblem(`Billable hours must be between 0 and the ${h} hours worked.`);
    if (akBillable !== null && (!Number.isFinite(akBillable) || akBillable < 0 || akBillable > h))
      return setProblem(`AK billable hours must be between 0 and the ${h} hours worked.`);
    setProblem(null);
    setSaving(true);
    const ok = await onAdd({
      matterId,
      hours: h,
      narrative: narrative.trim(),
      billableHours: billable,
      akBillableHours: akBillable,
    });
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a time entry</DialogTitle>
          <DialogDescription>For {dateLabel(workDate)}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="entry-project">Project</Label>
            <Select value={matterId} onValueChange={setMatterId}>
              <SelectTrigger id="entry-project">
                <SelectValue placeholder={activeMatters.length ? "Choose a project" : "No active projects"} />
              </SelectTrigger>
              <SelectContent>
                {activeMatters.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="entry-narrative">What you did</Label>
            <Textarea
              id="entry-narrative"
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="e.g. Meeting with the PPP Unit on the draft concession agreement"
              className="min-h-20"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="entry-hours">Hours</Label>
              <Input
                id="entry-hours"
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-billable">Billable hours</Label>
              <Input
                id="entry-billable"
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                placeholder="Optional"
                value={billableHours}
                onChange={(e) => setBillableHours(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-ak-billable">AK billable hours</Label>
              <Input
                id="entry-ak-billable"
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                placeholder="Optional"
                value={akBillableHours}
                onChange={(e) => setAkBillableHours(e.target.value)}
              />
            </div>
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Add entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EditableRow {
  id: string;
  matterId: string;
  narrative: string;
  hours: string;
  billableHours: string;
  akBillableHours: string;
}

function toEditableRow(slip: MyTimeslip): EditableRow {
  return {
    id: slip.id,
    matterId: slip.matter_id,
    narrative: slip.narrative,
    hours: String(slip.hours),
    billableHours: slip.billable_hours === null ? "" : String(slip.billable_hours),
    akBillableHours: slip.ak_billable_hours === null ? "" : String(slip.ak_billable_hours),
  };
}

interface RowProps {
  row: EditableRow;
  index: number;
  matters: MatterListItem[] | undefined;
  patchRow: (id: string, patch: Partial<EditableRow>) => void;
  saveField: (id: string, edits: MyTimeslipEdits) => void;
  clampToHours: (id: string, hours: number) => void;
  onDelete: (row: EditableRow) => void;
}

// A plain <tr ref/style/{...attributes}> — dnd-kit's sortable hook doesn't
// need (and mustn't get) an extra wrapper element, since a <table> requires
// every <tr> to be a direct child of its <tbody>.
function SortableTimeslipRow({ row, index, matters, patchRow, saveField, clampToHours, onDelete }: RowProps) {
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <TableRow ref={setNodeRef} style={style}>
      <TableCell className="align-top pt-3 text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
            title="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          {index + 1}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <Select
          value={row.matterId}
          onValueChange={(value) => {
            patchRow(row.id, { matterId: value });
            saveField(row.id, { matter_id: value });
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {matters?.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="align-top">
        <Textarea
          value={row.narrative}
          onChange={(e) => patchRow(row.id, { narrative: e.target.value })}
          onBlur={() => saveField(row.id, { narrative: row.narrative })}
          className="min-h-16 text-sm"
        />
      </TableCell>
      <TableCell className="align-top">
        <Input
          type="number"
          step="0.1"
          min="0"
          value={row.hours}
          onChange={(e) => patchRow(row.id, { hours: e.target.value })}
          onBlur={() => {
            const hours = Number(row.hours);
            if (!Number.isFinite(hours) || hours <= 0) {
              toast({
                title: "Hours not saved",
                description: "Hours must be more than 0. To remove this entry, use the bin icon at the end of the row.",
                variant: "destructive",
              });
              return;
            }
            saveField(row.id, { hours });
            clampToHours(row.id, hours);
          }}
          className="h-8 text-xs"
        />
      </TableCell>
      <TableCell className="align-top">
        <Input
          type="number"
          step="0.1"
          min="0"
          placeholder="-"
          value={row.billableHours}
          onChange={(e) => patchRow(row.id, { billableHours: e.target.value })}
          onBlur={() => {
            if (row.billableHours === "") {
              saveField(row.id, { billable_hours: null });
              return;
            }
            const hours = Number(row.hours) || 0;
            const entered = Number(row.billableHours);
            const value = Math.min(entered, hours);
            if (value !== entered) {
              patchRow(row.id, { billableHours: String(value) });
              toast({
                title: "Billable hours capped",
                description: `Can't exceed this row's ${hours.toFixed(1)} hours.`,
              });
            }
            saveField(row.id, { billable_hours: value });
          }}
          className="h-8 text-xs"
        />
      </TableCell>
      <TableCell className="align-top">
        <Input
          type="number"
          step="0.1"
          min="0"
          placeholder="-"
          value={row.akBillableHours}
          onChange={(e) => patchRow(row.id, { akBillableHours: e.target.value })}
          onBlur={() => {
            if (row.akBillableHours === "") {
              saveField(row.id, { ak_billable_hours: null });
              return;
            }
            const hours = Number(row.hours) || 0;
            const entered = Number(row.akBillableHours);
            const value = Math.min(entered, hours);
            if (value !== entered) {
              patchRow(row.id, { akBillableHours: String(value) });
              toast({
                title: "AK billable hours capped",
                description: `Can't exceed this row's ${hours.toFixed(1)} hours.`,
              });
            }
            saveField(row.id, { ak_billable_hours: value });
          }}
          className="h-8 text-xs"
        />
      </TableCell>
      <TableCell className="align-top">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          title="Delete this entry"
          aria-label="Delete this entry"
          onClick={() => onDelete(row)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default function TodaysTimesheetPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: myProfile } = useMyProfile();
  const { data: matters } = useMatters();
  const [downloading, setDownloading] = useState(false);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EditableRow | null>(null);

  // The day being shown, on the user's own calendar (never UTC — see
  // localISODate). Defaults to today; previous/next and the date box move it.
  const [workDate, setWorkDate] = useState(() => localISODate());
  const isToday = workDate === localISODate();
  const range = useMemo(() => ({ from: workDate, to: workDate }), [workDate]);
  const { data: slips, isLoading, error } = useMyTimeslips(user?.id, range);
  const updateTimeslip = useUpdateMyTimeslip();
  const reorderTimeslips = useReorderMyTimeslips();
  const addTimeslip = useAddMyTimeslip();
  const deleteTimeslip = useDeleteMyTimeslip();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Only re-seed local editable state when the actual set of entries
  // changes (add/remove) — not on every refetch — so a field the user is
  // mid-edit on doesn't get clobbered by the query settling after an
  // unrelated field's save, and so a drag-reorder (which also triggers a
  // refetch once the new sort_order values land) doesn't visibly snap the
  // rows back before that refetch resolves.
  const slipIds = `${workDate}|${(slips ?? []).map((s) => s.id).join(",")}`;
  useEffect(() => {
    setRows((slips ?? []).map(toEditableRow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slipIds]);

  const totalHours = rows.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  const anyBillableEntered = rows.some((r) => r.billableHours !== "");
  const anyAkBillableEntered = rows.some((r) => r.akBillableHours !== "");
  const totalBillableHours = rows.reduce((sum, r) => sum + (Number(r.billableHours) || 0), 0);
  const totalAkBillableHours = rows.reduce((sum, r) => sum + (Number(r.akBillableHours) || 0), 0);

  const matterName = (matterId: string) => matters?.find((m) => m.id === matterId)?.name ?? "Unknown Project";

  const patchRow = (id: string, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const saveField = async (id: string, edits: MyTimeslipEdits) => {
    try {
      await updateTimeslip.mutateAsync({ id, edits });
    } catch (err) {
      toast({ title: "Failed to save change", description: (err as Error).message, variant: "destructive" });
    }
  };

  // Billable and AK Billable are sub-portions of a row's own Hours — clamp
  // whichever was just entered (or re-clamp both when Hours itself drops
  // below a value already entered for either) rather than letting a typo
  // silently claim more billable time than was actually worked.
  const clampToHours = (id: string, hours: number) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;

    if (row.billableHours !== "" && Number(row.billableHours) > hours) {
      patchRow(id, { billableHours: String(hours) });
      saveField(id, { billable_hours: hours });
      toast({ title: "Billable hours capped", description: `Can't exceed this row's ${hours.toFixed(1)} hours.` });
    }
    if (row.akBillableHours !== "" && Number(row.akBillableHours) > hours) {
      patchRow(id, { akBillableHours: String(hours) });
      saveField(id, { ak_billable_hours: hours });
      toast({
        title: "AK billable hours capped",
        description: `Can't exceed this row's ${hours.toFixed(1)} hours.`,
      });
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = rows.findIndex((r) => r.id === active.id);
    const newIndex = rows.findIndex((r) => r.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(rows, oldIndex, newIndex);
    setRows(next);
    reorderTimeslips.mutate(
      next.map((r) => r.id),
      {
        onError: (err) =>
          toast({
            title: "The new order wasn't saved",
            description: (err as Error).message,
            variant: "destructive",
          }),
      }
    );
  };

  const handleAdd: AddEntryDialogProps["onAdd"] = async (entry) => {
    if (!user) return false;
    try {
      await addTimeslip.mutateAsync({
        author_id: user.id,
        matter_id: entry.matterId,
        work_date: workDate,
        hours: entry.hours,
        narrative: entry.narrative,
        billable_hours: entry.billableHours,
        ak_billable_hours: entry.akBillableHours,
        sort_order: rows.length,
      });
      toast({ title: "Entry added", description: `${entry.hours} h on ${matterName(entry.matterId)}.` });
      return true;
    } catch (err) {
      toast({ title: "Could not add the entry", description: (err as Error).message, variant: "destructive" });
      return false;
    }
  };

  const confirmDelete = async () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    try {
      await deleteTimeslip.mutateAsync(row.id);
      toast({ title: "Entry deleted" });
    } catch (err) {
      toast({ title: "Could not delete the entry", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleDownload = async () => {
    if (!rows.length) return;
    setDownloading(true);
    try {
      const employeeName = myProfile?.full_name || myProfile?.email || "Associate";
      const docxRows = rows.map((r, i) => ({
        srNo: i + 1,
        matterName: matterName(r.matterId),
        description: r.narrative,
        hours: Number(r.hours) || 0,
        billableHours: r.billableHours === "" ? null : Number(r.billableHours),
        akBillableHours: r.akBillableHours === "" ? null : Number(r.akBillableHours),
      }));
      const blob = await buildTimesheetDocxBlob(workDate, docxRows, roleLabel(myProfile?.role ?? null), employeeName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Daily-Timesheet-${workDate}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Failed to generate timesheet", description: (err as Error).message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Today's Timesheet</h1>
          <p className="text-muted-foreground">
            Your own daily timesheet. Add an entry for any day, edit anything below, or drag a row's grip handle to
            reorder it, before downloading.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Entries also arrive here from Timekeeper, the firm's optional desktop time tracker for Windows, once you
            press Upload to Hub in it; you do not need it to record time.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setAddOpen(true)} disabled={!user}>
            <Plus className="h-4 w-4 mr-2" />
            Add entry
          </Button>
          <Button onClick={handleDownload} disabled={!rows.length || !matters || downloading}>
            {downloading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Download Timesheet (.docx)
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setWorkDate((d) => shiftISODate(d, -1))}
          aria-label="Previous day"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Previous day
        </Button>
        <Input
          type="date"
          aria-label="Choose a day"
          className="h-9 w-auto"
          value={workDate}
          onChange={(e) => {
            if (e.target.value) setWorkDate(e.target.value);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setWorkDate((d) => shiftISODate(d, 1))}
          aria-label="Next day"
        >
          Next day
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
        {!isToday && (
          <Button variant="ghost" size="sm" onClick={() => setWorkDate(localISODate())}>
            Back to today
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {dateLabel(workDate)}
            {isToday && <span className="text-sm font-normal text-muted-foreground">(today)</span>}
          </CardTitle>
          <span className="text-sm font-medium tabular-nums">{totalHours.toFixed(1)} h</span>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your time entries…
            </div>
          ) : error ? (
            <div className="py-6 text-sm">
              <p className="font-medium text-destructive">Could not load your time entries.</p>
              <p className="mt-1 text-muted-foreground">{(error as Error)?.message ?? "Unknown error"}</p>
            </div>
          ) : !rows.length ? (
            <div className="py-6 text-sm text-muted-foreground space-y-3">
              <p>{isToday ? "No time recorded today yet." : "No time recorded for this day."}</p>
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={!user}>
                <Plus className="h-4 w-4 mr-2" />
                Add entry
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Sr. No.</TableHead>
                    <TableHead className="w-[200px]">Transaction</TableHead>
                    <TableHead className="min-w-[260px]">Project &amp; Description</TableHead>
                    <TableHead className="w-24">Hours</TableHead>
                    <TableHead className="w-32">Billable Hours</TableHead>
                    <TableHead className="w-32">AK Billable Hours</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Delete</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                    <TableBody>
                      {rows.map((row, i) => (
                        <SortableTimeslipRow
                          key={row.id}
                          row={row}
                          index={i}
                          matters={matters}
                          patchRow={patchRow}
                          saveField={saveField}
                          clampToHours={clampToHours}
                          onDelete={setPendingDelete}
                        />
                      ))}
                      <TableRow>
                        <TableCell colSpan={3} className="text-center font-medium">
                          Total Hours
                        </TableCell>
                        <TableCell className="font-medium tabular-nums">{totalHours.toFixed(1)}</TableCell>
                        <TableCell className="font-medium tabular-nums">
                          {anyBillableEntered ? totalBillableHours.toFixed(1) : "-"}
                        </TableCell>
                        <TableCell className="font-medium tabular-nums">
                          {anyAkBillableEntered ? totalAkBillableHours.toFixed(1) : "-"}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableBody>
                  </SortableContext>
                </DndContext>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddEntryDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        workDate={workDate}
        matters={matters}
        onAdd={handleAdd}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `${pendingDelete.hours} h on ${matterName(pendingDelete.matterId)}. This removes it from your timesheet and from the project's time records. It can't be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
