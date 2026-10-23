import { friendlyError } from "@/lib/friendlyError";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { ChangeCard, ChangeCounts, Decision, NotDone } from "@/lib/documentSave";
import { cn } from "@/lib/utils";

// The one Changes list for a Word document in the chat: every change the AI
// made to it, from Edit or Review, as a numbered card. Everything a card
// says (its source, state, note and who decided it) is the server's, shown
// as it comes. Waiting cards can be accepted or rejected here; the rest say
// why they cannot.
//
// The same list shows a stored project version marked up from claude.ai
// (DocumentViewer's Changes tab, useVersionChanges): the caller passes the
// cards and decide() for the version, and its own words for an empty list
// and for a site without the chat service.

const CHAT_EMPTY = "The AI hasn't changed this document yet. Ask for an edit or a review in the chat and its changes will be listed here.";
const CHAT_UNAVAILABLE = "The Changes list needs the firm's chat service, which isn't set up on this site. The document's changes are still in the Word file as tracked changes.";

export type ChangesFilter = "waiting" | "decided" | "not-placed" | "all";

const FILTERS: Array<{ key: ChangesFilter; label: string; match: (c: ChangeCard) => boolean }> = [
  { key: "waiting", label: "Waiting", match: (c) => c.state === "waiting" },
  { key: "decided", label: "Decided", match: (c) => c.state === "accepted" || c.state === "rejected" },
  { key: "not-placed", label: "Could not be placed", match: (c) => c.state === "could_not_place" },
  { key: "all", label: "All", match: () => true },
];

const PART_LABEL: Record<ChangeCard["where"]["part"], string> = {
  body: "",
  header: "Header",
  footer: "Footer",
  footnotes: "Footnotes",
  endnotes: "Endnotes",
};

/** "Clause 4.2 · paragraph 12", "Header · paragraph 1". */
function whereLabel(where: ChangeCard["where"]): string {
  const parts: string[] = [];
  if (PART_LABEL[where.part]) parts.push(PART_LABEL[where.part]);
  if (where.clause) parts.push(/^\d/.test(where.clause) ? `Clause ${where.clause}` : where.clause);
  if (where.paragraph != null) parts.push(`paragraph ${where.paragraph}`);
  return parts.join(" · ");
}

function decidedLabel(card: ChangeCard): string | null {
  if (!card.decided) return null;
  const when = new Date(card.decided.at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const who = card.decided.by?.name ?? (card.decided.by ? "a colleague" : null);
  return [who ? `by ${who}` : null, when].filter(Boolean).join(" · ");
}

const STATE_STYLE: Record<ChangeCard["state"], string> = {
  waiting: "border-amber-300/70 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/20",
  accepted: "border-emerald-300/60 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-950/20",
  rejected: "border-border bg-muted/40",
  could_not_place: "border-dashed border-border bg-background",
  needs_word: "border-dashed border-amber-400/70 bg-background",
  replaced: "border-dashed border-border bg-muted/20",
};

const BADGE_STYLE: Record<ChangeCard["state"], string> = {
  waiting: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  accepted: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  rejected: "bg-muted text-muted-foreground",
  could_not_place: "bg-muted text-muted-foreground",
  needs_word: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  replaced: "bg-muted text-muted-foreground",
};

function ChangeCardView({
  card,
  selected,
  busy,
  onSelect,
  onDecide,
}: {
  card: ChangeCard;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onDecide: (decision: Decision["decision"]) => void;
}) {
  const where = whereLabel(card.where);
  const decided = decidedLabel(card);
  return (
    <div
      data-change-id={card.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "cursor-pointer rounded-md border px-3 py-2 text-sm transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        STATE_STYLE[card.state],
        selected && "ring-2 ring-red-600",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="font-semibold">#{card.number}</span>
        <span className="text-muted-foreground">{card.sourceLabel}</span>
        {where && <span className="text-muted-foreground">· {where}</span>}
        <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium", BADGE_STYLE[card.state])}>{card.stateLabel}</span>
      </div>
      {(card.before || card.after) && (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
          {card.before && <del className="text-red-700 line-through decoration-red-700/70 dark:text-red-400">{card.before}</del>}
          {card.before && card.after && <span className="px-1 text-muted-foreground" aria-hidden>→</span>}
          {card.after && <ins className="text-emerald-800 underline decoration-emerald-700/70 dark:text-emerald-300">{card.after}</ins>}
        </p>
      )}
      {card.why && <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{card.why}</p>}
      {card.stateNote && <p className="mt-1 text-xs font-medium text-amber-900 dark:text-amber-300">{card.stateNote}</p>}
      {decided && <p className="mt-1 text-[11px] text-muted-foreground">{card.stateLabel} {decided}</p>}
      {(card.canAccept || card.canReject) && (
        <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {card.canAccept && (
            <Button size="sm" className="h-7" disabled={busy} onClick={() => onDecide("accepted")} data-testid="change-accept">
              <Check className="mr-1 h-3.5 w-3.5" />
              Accept
            </Button>
          )}
          {card.canReject && (
            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => onDecide("rejected")} data-testid="change-reject">
              <X className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChangesPanel({
  cards,
  counts,
  loading,
  error,
  available,
  deciding,
  selectedId,
  onSelect,
  onDecide,
  onReload,
  emptyText = CHAT_EMPTY,
  unavailableText = CHAT_UNAVAILABLE,
}: {
  cards: ChangeCard[] | undefined;
  counts: Partial<ChangeCounts> | null;
  loading: boolean;
  error: string | null;
  available: boolean;
  deciding: boolean;
  selectedId: string | null;
  onSelect: (card: ChangeCard) => void;
  onDecide: (decisions: Decision[]) => Promise<{ notDone: NotDone[] }>;
  onReload: () => void;
  /** Said when the list has no changes at all. */
  emptyText?: string;
  /** Said when the site has no chat service to list or decide with. */
  unavailableText?: string;
}) {
  const { toast } = useToast();
  const waitingCount = counts?.waiting ?? 0;
  const [filter, setFilter] = useState<ChangesFilter>(waitingCount > 0 ? "waiting" : "all");
  const [confirm, setConfirm] = useState<Decision["decision"] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const all = useMemo(() => cards ?? [], [cards]);
  const waiting = useMemo(() => all.filter((c) => c.canAccept), [all]);
  const shown = useMemo(() => all.filter(FILTERS.find((f) => f.key === filter)!.match), [all, filter]);
  // Once nothing is left waiting, show everything rather than an empty list;
  // when a new turn brings changes to decide, show those.
  const lastWaiting = useRef(waitingCount);
  useEffect(() => {
    if (filter === "waiting" && cards && waiting.length === 0) setFilter("all");
  }, [filter, cards, waiting.length]);
  useEffect(() => {
    if (waitingCount > lastWaiting.current) setFilter("waiting");
    lastWaiting.current = waitingCount;
  }, [waitingCount]);

  const run = async (decisions: Decision[], what: string) => {
    try {
      const result = await onDecide(decisions);
      if (result.notDone.length) {
        const n = result.notDone.length;
        toast({
          title: `${n} change${n === 1 ? " was" : "s were"} not decided`,
          description: result.notDone.slice(0, 3).map((d) => d.note).join(" "),
        });
      } else if (decisions.length > 1) {
        toast({ title: what });
      }
    } catch (err) {
      toast({ title: "Couldn't record the decision", description: friendlyError(err), variant: "destructive" });
    }
  };

  const decideOne = async (card: ChangeCard, decision: Decision["decision"]) => {
    setBusyId(card.id);
    try {
      await run([{ changeId: card.id, decision }], "");
    } finally {
      setBusyId(null);
    }
  };

  const decideAll = async (decision: Decision["decision"]) => {
    setConfirm(null);
    const n = waiting.length;
    await run(
      waiting.map((c) => ({ changeId: c.id, decision })),
      `${decision === "accepted" ? "Accepted" : "Rejected"} ${n} change${n === 1 ? "" : "s"}`,
    );
  };

  if (!available) {
    return <p className="p-4 text-sm text-muted-foreground">{unavailableText}</p>;
  }

  const countFor = (key: ChangesFilter) => all.filter(FILTERS.find((f) => f.key === key)!.match).length;
  const needsWord = counts?.needsWord ?? 0;
  const others = counts?.othersRevisions ?? 0;
  const unlisted = counts?.unlisted ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-panel">
      <div className="space-y-2 border-b px-3 py-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Show changes">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs",
                filter === f.key ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {f.label} ({cards ? countFor(f.key) : "…"})
            </button>
          ))}
          <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={onReload} aria-label="Reload the changes" title="Reload the changes">
            <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
        {waiting.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="h-7" disabled={deciding} onClick={() => setConfirm("accepted")} data-testid="accept-all-waiting">
              {deciding ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              Accept all waiting
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={deciding} onClick={() => setConfirm("rejected")} data-testid="reject-all-waiting">
              <X className="mr-1 h-3.5 w-3.5" />
              Reject all waiting
            </Button>
          </div>
        )}
        {(needsWord > 0 || unlisted > 0 || others > 0) && (
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            {needsWord > 0 && <p>{needsWord} change{needsWord === 1 ? "" : "s"} can only be decided in Word. They are under All.</p>}
            {unlisted > 0 && <p>The file has {unlisted} AI change{unlisted === 1 ? "" : "s"} that {unlisted === 1 ? "is" : "are"} not in this list. Decide {unlisted === 1 ? "it" : "them"} in Word.</p>}
            {others > 0 && <p>The file also has {others} tracked change{others === 1 ? "" : "s"} by other people. They are left as they are.</p>}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="changes-list">
        {loading && !cards && <p className="text-sm text-muted-foreground">Loading the changes…</p>}
        {error && (
          <p className="text-sm text-destructive">
            {error}{" "}
            <button type="button" className="underline" onClick={onReload}>
              Try again
            </button>
          </p>
        )}
        {cards && all.length === 0 && <p className="text-sm text-muted-foreground">{emptyText}</p>}
        {cards && all.length > 0 && shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing here. Choose All to see every change.</p>}
        {shown.map((card) => (
          <ChangeCardView
            key={card.id}
            card={card}
            selected={selectedId === card.id}
            busy={deciding || busyId === card.id}
            onSelect={() => onSelect(card)}
            onDecide={(decision) => void decideOne(card, decision)}
          />
        ))}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "accepted" ? "Accept" : "Reject"} all {waiting.length} waiting change{waiting.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "accepted"
                ? `The ${waiting.length === 1 ? "change is" : `${waiting.length} changes are`} written into the document and the tracked-change markup is removed.`
                : `The ${waiting.length === 1 ? "change is" : `${waiting.length} changes are`} taken out and the document's own wording is kept.`}{" "}
              You can see each decision on its card afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void decideAll(confirm)}>
              {confirm === "accepted" ? "Accept" : "Reject"} {waiting.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
