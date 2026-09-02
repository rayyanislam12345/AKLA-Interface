import { useEffect, useMemo, useState } from "react";
import { Clock, Download, GripVertical, Loader2 } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useMatters, type MatterListItem } from "@/hooks/useMatters";
import {
  MyTimeslip,
  MyTimeslipEdits,
  resolveRange,
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

function todayLabel() {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
}

// A plain <tr ref/style/{...attributes}> — dnd-kit's sortable hook doesn't
// need (and mustn't get) an extra wrapper element, since a <table> requires
// every <tr> to be a direct child of its <tbody>.
function SortableTimeslipRow({ row, index, matters, patchRow, saveField, clampToHours }: RowProps) {
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
            const hours = Number(row.hours) || 0;
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

  const range = useMemo(() => resolveRange("today"), []);
  const { data: slips, isLoading, error } = useMyTimeslips(user?.id, range);
  const updateTimeslip = useUpdateMyTimeslip();
  const reorderTimeslips = useReorderMyTimeslips();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Only re-seed local editable state when the actual set of entries
  // changes (add/remove) — not on every refetch — so a field the user is
  // mid-edit on doesn't get clobbered by the query settling after an
  // unrelated field's save, and so a drag-reorder (which also triggers a
  // refetch once the new sort_order values land) doesn't visibly snap the
  // rows back before that refetch resolves.
  const slipIds = (slips ?? []).map((s) => s.id).join(",");
  useEffect(() => {
    setRows((slips ?? []).map(toEditableRow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slipIds]);

  const totalHours = rows.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  const anyBillableEntered = rows.some((r) => r.billableHours !== "");
  const anyAkBillableEntered = rows.some((r) => r.akBillableHours !== "");
  const totalBillableHours = rows.reduce((sum, r) => sum + (Number(r.billableHours) || 0), 0);
  const totalAkBillableHours = rows.reduce((sum, r) => sum + (Number(r.akBillableHours) || 0), 0);

  const matterName = (matterId: string) => matters?.find((m) => m.id === matterId)?.name ?? "Unknown Matter";

  const patchRow = (id: string, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const saveField = async (id: string, edits: MyTimeslipEdits) => {
    try {
      await updateTimeslip.mutateAsync({ id, edits });
    } catch (err: any) {
      toast({ title: "Failed to save change", description: err.message, variant: "destructive" });
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
    reorderTimeslips.mutate(next.map((r) => r.id));
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
      const today = range.from!;
      const blob = await buildTimesheetDocxBlob(today, docxRows, roleLabel(myProfile?.role ?? null), employeeName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Daily-Timesheet-${today}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Failed to generate timesheet", description: err.message, variant: "destructive" });
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
            Your own daily timesheet, built from entries logged via Timekeeper — edit anything below, or drag a
            row's grip handle to reorder it, before downloading.
          </p>
        </div>
        <Button onClick={handleDownload} disabled={!rows.length || downloading}>
          {downloading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Download Timesheet (.docx)
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {todayLabel()}
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
            <p className="py-6 text-sm text-muted-foreground">
              No time recorded today yet. Entries logged via Timekeeper will show up here once uploaded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Sr. No.</TableHead>
                    <TableHead className="w-[200px]">Transaction</TableHead>
                    <TableHead className="min-w-[260px]">Matter &amp; Description</TableHead>
                    <TableHead className="w-24">Hours</TableHead>
                    <TableHead className="w-32">Billable Hours</TableHead>
                    <TableHead className="w-32">AK Billable Hours</TableHead>
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
                      </TableRow>
                    </TableBody>
                  </SortableContext>
                </DndContext>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
