import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadState } from "@/components/LoadState";
import { ProjectPicker } from "@/components/ProjectPicker";
import { TransactionRowPicker } from "@/components/TransactionRowPicker";
import { TrayProjectDialog } from "@/components/TrayProjectDialog";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { arrivedFromLine, formatDayMonth, personName } from "@/lib/intake";
import { formatLongDate, formatShortDate, isOpenStatus, readTrayItem, type TrayItemView } from "@/lib/transactions";
import { useAcceptMessageLine, useAnswerTrayDocument, useNameProjectFromTray, type DocumentAnswer } from "@/hooks/useIntake";
import { useMatters, type MatterListItem } from "@/hooks/useMatters";
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

// The page's groups, in the order a person would clear them: a project the
// Hub lacks first (documents wait on it), then documents, emails, agendas.
const GROUPS: { kind: string; heading: string }[] = [
  { kind: "new_project", heading: "Projects the Hub doesn't have" },
  { kind: "document_unsure", heading: "Documents: the next version, or a new one?" },
  { kind: "document_no_project", heading: "Documents with no project" },
  { kind: "document_undone", heading: "Filings taken back" },
  { kind: "message_unsure", heading: "Emails, not sure which row" },
  { kind: "agenda_line_unsure", heading: "Agenda lines, not sure which row" },
  { kind: "agenda_line_no_row", heading: "Agenda lines with no row" },
  { kind: "time_no_row", heading: "Hours with no row" },
  { kind: "excel_conflict", heading: "Changed on the Hub and in the sheet" },
  { kind: "agenda_unreadable", heading: "Agendas the Hub couldn't read" },
];
const OTHER = "other";

// With only a handful waiting, everything is open; beyond that only the first group is.
const OPEN_ALL_UP_TO = 8;

const DOCUMENT_KINDS = ["document_no_project", "document_unsure", "document_undone"];

type ProjectRef = Pick<MatterListItem, "id" | "name">;

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

/** "Probably: <row>", the Hub's best guess at the row. */
function ProbablyRow({ row }: { row: TransactionRow | undefined }) {
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">Probably: </span>
      {row ? (
        <>
          <span className="font-medium">{row.deliverable}</span> ({row.client} · {row.project})
        </>
      ) : (
        "a row the Hub can no longer find"
      )}
    </p>
  );
}

interface CardProps {
  item: TrayItem;
  rowsById: Map<string, TransactionRow>;
  projectsById: Map<string, MatterListItem>;
  busy: boolean;
  onAdd: () => void;
  onAccept: (rowId: string) => void;
  onPick: () => void;
  onDrop: () => void;
  onKeep: (keep: "hub" | "excel") => void;
  /** Where a document goes. */
  onFile: (answer: DocumentAnswer, projectName: string) => void;
  onPickProject: () => void;
  onCreateProject: () => void;
  /** A proposed project is this existing one. */
  onNameProject: (project: ProjectRef) => void;
}

/** One tray item, worded by kind, with the buttons that clear it. */
function TrayCard({ item, rowsById, projectsById, busy, onAdd, onAccept, onPick, onDrop, onKeep, onFile, onPickProject, onCreateProject, onNameProject }: CardProps) {
  const v = readTrayItem(item);
  const guessed = v.guessRowId ? rowsById.get(v.guessRowId) : undefined;
  const conflictRow = v.rowId ? rowsById.get(v.rowId) : undefined;
  const kind = item.kind;
  const isDocument = DOCUMENT_KINDS.includes(kind);
  const fileName = v.file || v.title || "A document";
  const project = v.matterId ? projectsById.get(v.matterId) : undefined;
  const guessedProject = v.guessMatterId ? projectsById.get(v.guessMatterId) : undefined;
  const wasProject = v.wasMatterId ? projectsById.get(v.wasMatterId) : undefined;
  // The likeliest existing project, named by the Hub's list when it has it.
  const near: ProjectRef | undefined = v.near
    .map((n) => ({ id: n.matterId, name: projectsById.get(n.matterId)?.name || n.name }))
    .find((n) => n.name);
  const latest = v.seen[0];

  const title = (() => {
    switch (kind) {
      case "agenda_line_no_row":
      case "agenda_line_unsure":
        // The group's heading already says what kind of question this is.
        return [v.person, [v.transaction, v.deliverable].filter(Boolean).join(" / ")].filter(Boolean).join(": ") || KIND_TITLES[kind];
      case "excel_conflict":
        return `${v.field || "A cell"} on ${conflictRow?.deliverable || v.deliverable || "a row"}`;
      case "time_no_row":
        return `${[v.person, v.date ? formatShortDate(v.date) : "", v.hours ? `${v.hours} h` : ""].filter(Boolean).join(", ")}${v.transaction ? ` on ${v.transaction}` : ""}` || KIND_TITLES[kind];
      case "agenda_unreadable":
        return v.file || "A file";
      case "document_no_project":
      case "document_undone":
        return fileName;
      case "document_unsure":
        return `Is ${fileName} the next version of ${v.guessDocumentTitle || "a document already on the project"}?`;
      case "new_project":
        return `The firm is working on ${v.name || v.code || "a project the Hub doesn't have"}`;
      case "message_unsure": {
        // "Owais Sb: asks for…", but an ask that already opens with the sender's name is not prefixed with it again.
        const who = personName(v.person);
        const says = v.ask || v.scope || v.deliverable;
        if (who && says.toLowerCase().startsWith(who.toLowerCase())) return says;
        return [who, says].filter(Boolean).join(": ") || "An email";
      }
      default:
        return KIND_TITLES[kind] ?? kind;
    }
  })();

  const under = (() => {
    if (isDocument) return arrivedFromLine(v);
    if (kind === "new_project") {
      const times = v.count > 1 ? `Seen ${v.count} times` : "Seen once";
      const where = latest ? [latest.where && `in ${latest.where}`, latest.person && `by ${personName(latest.person)}`].filter(Boolean).join(" ") : "";
      return where ? `${times}, most recently ${where}` : times;
    }
    if (kind === "message_unsure") {
      return [project?.name || v.transaction, v.deliverable, v.date ? formatDayMonth(v.date) : ""].filter(Boolean).join(" · ");
    }
    return `Arrived ${formatLongDate(item.created_at)}${v.file && kind !== "agenda_unreadable" ? ` · ${v.file}` : ""}`;
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="break-words text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {under}
          {isDocument && v.webUrl && (
            <>
              {under ? " · " : ""}
              <a href={v.webUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                Open on SharePoint
              </a>
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {kind === "agenda_line_unsure" && <ProbablyRow row={guessed} />}
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
        {kind === "document_no_project" && <Field label="Filed on SharePoint under" value={v.transaction} />}
        {kind === "document_undone" && <Field label="Taken back from" value={wasProject?.name ?? ""} />}
        {kind === "document_unsure" && <Field label="Project" value={project?.name ?? ""} />}
        {kind === "new_project" && near && (
          <p className="text-sm">
            <span className="text-muted-foreground">It may be </span>
            <span className="font-medium">{near.name}</span>
          </p>
        )}
        {kind === "message_unsure" && (
          <>
            {v.guessRowId && <ProbablyRow row={guessed} />}
            {v.ask && v.scope && v.scope !== v.ask && <Field label="The email says" value={v.scope} />}
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
          {(kind === "document_no_project" || kind === "document_undone") && (
            <>
              {guessedProject && (
                <Button size="sm" onClick={() => onFile({ matter_id: guessedProject.id }, guessedProject.name)} disabled={busy}>
                  File in {guessedProject.name}
                </Button>
              )}
              <Button size="sm" variant={guessedProject ? "outline" : "default"} onClick={onPickProject} disabled={busy}>
                Pick project…
              </Button>
              {!guessedProject && v.guessNewProject && (
                <Button size="sm" variant="outline" onClick={onCreateProject} disabled={busy}>
                  Create the project…
                </Button>
              )}
            </>
          )}
          {kind === "document_unsure" && (
            <>
              <Button
                size="sm"
                onClick={() => onFile({ matter_id: v.matterId, document_id: v.guessDocumentId }, project?.name ?? "")}
                disabled={busy || !v.matterId || !v.guessDocumentId}
              >
                Yes, the next version
              </Button>
              <Button size="sm" variant="outline" onClick={() => onFile({ matter_id: v.matterId, new_document: true }, project?.name ?? "")} disabled={busy || !v.matterId}>
                A new document
              </Button>
            </>
          )}
          {kind === "new_project" && (
            <>
              {near && (
                <Button size="sm" onClick={() => onNameProject(near)} disabled={busy}>
                  It's {near.name}
                </Button>
              )}
              <Button size="sm" variant={near ? "outline" : "default"} onClick={onCreateProject} disabled={busy}>
                Create the project
              </Button>
              <Button size="sm" variant="outline" onClick={onPickProject} disabled={busy}>
                {near ? "It's another project…" : "It's this project…"}
              </Button>
            </>
          )}
          {kind === "message_unsure" && (
            <>
              {v.guessRowId && (
                <Button size="sm" onClick={() => onAccept(v.guessRowId)} disabled={busy || !guessed}>
                  Yes, that row
                </Button>
              )}
              <Button size="sm" variant={v.guessRowId ? "outline" : "default"} onClick={onPick} disabled={busy}>
                {v.guessRowId ? "Another row…" : "It's this row…"}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onDrop} disabled={busy}>
            {isDocument ? "Not ours" : "Drop"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function IntakeTrayPage() {
  const { data: items, isLoading, error, refetch } = useOpenTray();
  const { data: rows } = useTransactionRows();
  const { data: projects } = useMatters();
  const accept = useAcceptAgendaLine();
  const acceptMessage = useAcceptMessageLine();
  const answerDocument = useAnswerTrayDocument();
  const nameProject = useNameProjectFromTray();
  const resolveConflict = useResolveExcelConflict();
  const drop = useDropTrayItem();
  const { toast } = useToast();
  const [pickFor, setPickFor] = useState<TrayItem | null>(null);
  const [projectFor, setProjectFor] = useState<TrayItem | null>(null);
  const [createFor, setCreateFor] = useState<TrayItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Groups the person has opened or closed by hand (true = open); the rest follow the default.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

  const rowsById = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const projectsById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const openRows = useMemo(() => (rows ?? []).filter((r) => isOpenStatus(r.status)), [rows]);

  // An email names its project: that project's rows come first in the picker.
  const pickRows = useMemo(() => {
    const matterId = pickFor?.kind === "message_unsure" ? readTrayItem(pickFor).matterId : "";
    if (!matterId) return openRows;
    return [...openRows.filter((r) => r.matter_id === matterId), ...openRows.filter((r) => r.matter_id !== matterId)];
  }, [openRows, pickFor]);

  const groups = useMemo(() => {
    const known = new Set(GROUPS.map((g) => g.kind));
    const all = [...GROUPS, { kind: OTHER, heading: "Other" }];
    return all
      .map((g) => ({ ...g, items: (items ?? []).filter((i) => (g.kind === OTHER ? !known.has(i.kind) : i.kind === g.kind)) }))
      .filter((g) => g.items.length > 0);
  }, [items]);

  const run = async (item: TrayItem, work: () => Promise<unknown>, done: string, failed: string, description?: string) => {
    setBusyId(item.id);
    try {
      await work();
      toast({ title: done, description });
    } catch (e) {
      toast({ title: failed, description: friendlyError(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const placeOnRow = (item: TrayItem, rowId: string, done: string) =>
    item.kind === "message_unsure"
      ? run(item, () => acceptMessage.mutateAsync({ item, rowId }), done, "Couldn't place the line")
      : run(item, () => accept.mutateAsync({ item, rowId }), done, "Couldn't place the line");

  const fileDocument = (item: TrayItem, answer: DocumentAnswer, projectName: string) =>
    run(
      item,
      () => answerDocument.mutateAsync({ item, answer }),
      projectName ? `Noted for ${projectName}` : "Noted",
      "Couldn't save that",
      "It will be filed within a few minutes.",
    );

  const itIsProject = (item: TrayItem, project: ProjectRef) =>
    run(
      item,
      () => nameProject.mutateAsync({ item, matterId: project.id }),
      `Noted: it is ${project.name}`,
      "Couldn't save that",
      "Anything waiting for it will be filed within a few minutes.",
    );

  const count = items?.length ?? 0;
  const closedByDefault = (index: number) => count > OPEN_ALL_UP_TO && index > 0;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/transactions" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Transactions Hub
        </Link>
        <h1 className="text-2xl font-semibold">Needs a look{count ? ` · ${count}` : ""}</h1>
        <p className="text-muted-foreground">What arrived that the Hub could not place on its own, one kind at a time. Oldest first.</p>
      </div>

      <LoadState isLoading={isLoading} error={error} onRetry={() => refetch()} what="the tray" isEmpty={!count} empty="Nothing needs a look. Everything that arrived found its place.">
        <div className="space-y-5">
          {groups.map((g, index) => {
            const closed = g.kind in chosen ? !chosen[g.kind] : closedByDefault(index);
            return (
              <section key={g.kind}>
                <div className="border-b pb-1">
                  <button type="button" className="flex w-full min-w-0 items-center gap-1.5 px-1 text-left" onClick={() => setChosen((prev) => ({ ...prev, [g.kind]: closed }))} aria-expanded={!closed}>
                    {closed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <h2 className="truncate text-sm font-semibold">{g.heading}</h2>
                    <span className="shrink-0 text-xs text-muted-foreground">{g.items.length}</span>
                  </button>
                </div>
                {!closed && (
                  <div className="mt-3 space-y-3">
                    {g.items.map((item) => (
                      <TrayCard
                        key={item.id}
                        item={item}
                        rowsById={rowsById}
                        projectsById={projectsById}
                        busy={busyId === item.id}
                        onAdd={() => run(item, () => accept.mutateAsync({ item }), "Row added to the sheet", "Couldn't add the row")}
                        onAccept={(rowId) => placeOnRow(item, rowId, "Line placed on the row")}
                        onPick={() => setPickFor(item)}
                        onDrop={() => run(item, () => drop.mutateAsync(item), "Dropped", "Couldn't drop it")}
                        onKeep={(keep) =>
                          run(item, () => resolveConflict.mutateAsync({ item, keep }), keep === "hub" ? "Kept the Hub's value" : "Took the sheet's value", "Couldn't settle it")
                        }
                        onFile={(answer, projectName) => fileDocument(item, answer, projectName)}
                        onPickProject={() => setProjectFor(item)}
                        onCreateProject={() => setCreateFor(item)}
                        onNameProject={(project) => itIsProject(item, project)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </LoadState>

      <TransactionRowPicker
        open={!!pickFor}
        onOpenChange={(open) => !open && setPickFor(null)}
        rows={pickRows}
        onPick={(row) => {
          const item = pickFor;
          if (!item) return;
          void placeOnRow(item, row.id, `Placed on ${row.deliverable}`);
        }}
      />
      <ProjectPicker
        open={!!projectFor}
        onOpenChange={(open) => !open && setProjectFor(null)}
        projects={projects ?? []}
        onPick={(project) => {
          const item = projectFor;
          if (!item) return;
          if (item.kind === "new_project") void itIsProject(item, project);
          else void fileDocument(item, { matter_id: project.id }, project.name);
        }}
      />
      <TrayProjectDialog item={createFor} onClose={() => setCreateFor(null)} />
    </div>
  );
}
