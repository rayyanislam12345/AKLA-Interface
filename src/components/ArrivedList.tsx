import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useUndoIntakeAction } from "@/hooks/useIntake";
import {
  actionSourceLine,
  actionVerb,
  canUndo,
  groupArrivals,
  groupArrivalsByDay,
  isUndone,
  type Arrival,
  type IntakeAction,
} from "@/lib/intake";

const ROW_LINES = ["row_update", "row_moved"];
const QUIET_LINK = "text-muted-foreground underline underline-offset-2 hover:text-foreground";

/** What pressing Undo on this line will do, for the button's tooltip. */
function undoHint(action: IntakeAction, coversRowLine: boolean): string {
  switch (action.kind) {
    case "version_filed":
      return coversRowLine
        ? "Takes this version off the project, and the line it added to the row. The file stays on SharePoint."
        : "Takes this version off the project. The file stays on SharePoint.";
    case "row_moved":
      return "Removes the line and puts the row back as it was.";
    case "row_created":
      return "Takes the row off the sheet.";
    case "note_added":
      return "Removes this note from the project.";
    default:
      return "Removes this line from the row.";
  }
}

interface LineProps {
  action: IntakeAction;
  /** A second thing the same arrival did, shown indented under the first. */
  child?: boolean;
  /** The Undo on the filing above takes this line back too. */
  covered?: boolean;
  coversRowLine?: boolean;
  showProject?: boolean;
}

/** One thing the Hub did, as one quiet line; clicking the words shows them in full. */
function ActionLine({ action, child = false, covered = false, coversRowLine = false, showProject = false }: LineProps) {
  const [open, setOpen] = useState(false);
  const undo = useUndoIntakeAction();
  const undone = isUndone(action);
  const source = child ? "" : [actionSourceLine(action), showProject ? action.projectName : ""].filter(Boolean).join(" · ");
  const extra = [action.file && !action.summary.includes(action.file) ? action.file : "", action.subject].filter(Boolean).join(" · ");
  // The same address the search results and the reading view use for a version on its project page.
  const openLink =
    action.kind === "version_filed" && !undone && action.matterId && action.documentId
      ? `/matters/${action.matterId}?document=${action.documentId}${action.versionId ? `#version-${action.versionId}` : ""}`
      : null;

  return (
    <li className={cn("flex items-start gap-3 rounded-md px-3", child ? "py-1 pl-8" : "py-2", undone && "text-muted-foreground")}>
      <span className="hidden w-[5.5rem] shrink-0 pt-0.5 text-xs text-muted-foreground sm:block">{actionVerb(action.kind)}</span>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="block w-full text-left">
          <span className={cn("block text-sm", open ? "whitespace-pre-wrap break-words" : "truncate", child && "text-muted-foreground")}>{action.summary}</span>
          {source && <span className={cn("block text-xs text-muted-foreground", open ? "break-words" : "truncate")}>{source}</span>}
        </button>
        {open && (extra || action.webUrl) && (
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            {extra}
            {extra && action.webUrl ? " · " : ""}
            {action.webUrl && (
              <a href={action.webUrl} target="_blank" rel="noreferrer" className={QUIET_LINK}>
                Open on SharePoint
              </a>
            )}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-3 pt-0.5 text-xs">
        {openLink && (
          <Link to={openLink} className={QUIET_LINK}>
            Open
          </Link>
        )}
        {undone ? (
          <span className="text-muted-foreground">Undone</span>
        ) : (
          !covered &&
          canUndo(action) && (
            <button
              type="button"
              className={cn(QUIET_LINK, "disabled:no-underline disabled:opacity-60")}
              title={undoHint(action, coversRowLine)}
              disabled={undo.isPending}
              onClick={() => undo.mutate(action)}
            >
              {undo.isPending ? "Undoing…" : "Undo"}
            </button>
          )
        )}
      </span>
    </li>
  );
}

/** A filing with the row line it wrote beneath it; one Undo on the filing takes both back. */
function ArrivalLines({ arrival, showProject }: { arrival: Arrival<IntakeAction>; showProject: boolean }) {
  const { lead, rest } = arrival;
  const leadCovers = lead.kind === "version_filed" && !isUndone(lead);
  const coveredIds = new Set(leadCovers ? rest.filter((a) => ROW_LINES.includes(a.kind) && !isUndone(a)).map((a) => a.id) : []);
  return (
    <>
      <ActionLine action={lead} showProject={showProject} coversRowLine={coveredIds.size > 0} />
      {rest.map((a) => (
        <ActionLine key={a.id} action={a} child covered={coveredIds.has(a.id)} />
      ))}
    </>
  );
}

interface ArrivedListProps {
  actions: IntakeAction[];
  /** Name the project on each line (the Arrived page; a project's own card has no need). */
  showProject?: boolean;
  /** For a card: no day headings. */
  compact?: boolean;
  /** Show only the newest so many arrivals. */
  max?: number;
  empty?: string;
}

/** What the Hub filed, moved or noted on its own, newest first, each with its Undo. */
export function ArrivedList({ actions, showProject = false, compact = false, max, empty = "Nothing has arrived yet." }: ArrivedListProps) {
  const limited = useMemo(() => {
    if (!max) return actions;
    const keep = new Set(groupArrivals(actions).slice(0, max).map((g) => g.key));
    return actions.filter((a) => keep.has(a.groupId || a.id));
  }, [actions, max]);
  const days = useMemo(() => groupArrivalsByDay(limited), [limited]);

  if (!limited.length) return <p className="text-sm text-muted-foreground">{empty}</p>;

  if (compact) {
    return (
      <ul>
        {days.flatMap((day) => day.items).map((arrival) => (
          <ArrivalLines key={arrival.key} arrival={arrival} showProject={showProject} />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day.key}>
          <h2 className="mb-1 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{day.label}</h2>
          <ul>
            {day.items.map((arrival) => (
              <ArrivalLines key={arrival.key} arrival={arrival} showProject={showProject} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
