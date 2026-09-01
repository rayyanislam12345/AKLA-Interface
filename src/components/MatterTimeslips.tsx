import { useMemo, useState } from "react";
import { Clock, Download, Loader2 } from "lucide-react";
import {
  MatterTimeslip,
  RANGE_LABELS,
  RangePreset,
  authorName,
  byTask,
  resolveRange,
  summarise,
  useMatterTimeslips,
} from "@/hooks/useMatterTimeslips";
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

export function MatterTimeslips({
  matterId,
  matterName,
}: {
  matterId: string;
  matterName: string;
}) {
  const [preset, setPreset] = useState<RangePreset>("30");
  const [view, setView] = useState<View>("entries");
  const range = useMemo(() => resolveRange(preset), [preset]);
  const { data: slips, isLoading, error } = useMatterTimeslips(matterId, range);

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Date</TableHead>
                <TableHead className="w-[150px]">Associate</TableHead>
                <TableHead className="w-[64px] text-right">Hours</TableHead>
                <TableHead className="w-[70px]">Code</TableHead>
                <TableHead>Narrative</TableHead>
                <TableHead className="w-[150px]">Task</TableHead>
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
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
        )}
      </CardContent>
    </Card>
  );
}
