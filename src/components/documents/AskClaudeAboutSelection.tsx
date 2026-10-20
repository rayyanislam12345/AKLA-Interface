import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MessageSquareQuote } from "lucide-react";
import { postToCompanion, useCompanionHost } from "@/lib/embedMode";
import { tidyPassage } from "@/lib/selectionPassage";

// In the companion's drawer (the Hub beside a claude.ai chat), highlighting
// a passage of the drawn Word file brings up one small button by the
// selection: "Ask Claude about this". It hands the passage, with the
// version's name and id, to the companion, which puts it in the chat's
// message box quoted, ready for the lawyer to say what to change. Nothing is
// sent to Claude until the lawyer sends the message. Never shown in the
// ordinary Hub.

/** The version on show, as the companion names it in the chat. */
export interface CompanionSource {
  title: string;
  versionId: string;
  versionNumber: number;
  fileName?: string | null;
  projectName?: string | null;
}

interface Props {
  /** The drawn document: only a selection inside it counts. */
  contentRef: RefObject<HTMLElement>;
  /** The scrolling box around it: a selection scrolled out of it hides the button. */
  scrollRef: RefObject<HTMLElement>;
  source: CompanionSource;
}

interface Spot {
  text: string;
  truncated: boolean;
  top: number;
  left: number;
}

const BUTTON_H = 32;
const BUTTON_W = 190;
const GAP = 6;

export function AskClaudeAboutSelection({ contentRef, scrollRef, source }: Props) {
  const companion = useCompanionHost();
  const [spot, setSpot] = useState<Spot | null>(null);
  const dragging = useRef(false);
  const dismissed = useRef<string | null>(null); // the selection already sent, or put away with Escape
  const frame = useRef(0);

  const measure = useCallback(() => {
    frame.current = 0;
    const content = contentRef.current;
    const box = scrollRef.current;
    const sel = window.getSelection();
    if (!content || !box || !sel || sel.isCollapsed || sel.rangeCount === 0 || dragging.current) return setSpot(null);
    const range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return setSpot(null);
    const raw = sel.toString();
    if (dismissed.current !== null && dismissed.current === raw) return setSpot(null);
    dismissed.current = null;
    const passage = tidyPassage(raw);
    if (!passage.text) return setSpot(null);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    if (!rects.length) return setSpot(null);
    const first = rects[0];
    const last = rects[rects.length - 1];
    const view = box.getBoundingClientRect();
    // Scrolled out of the document's box: no button floating over other things.
    if (last.bottom < view.top || first.top > view.bottom) return setSpot(null);
    let top = last.bottom + GAP;
    if (top + BUTTON_H > view.bottom) top = first.top - BUTTON_H - GAP; // no room under it: above
    top = Math.min(Math.max(top, view.top + GAP), view.bottom - BUTTON_H - GAP);
    const left = Math.min(Math.max(last.right - BUTTON_W / 2, view.left + GAP), view.right - BUTTON_W - GAP);
    setSpot({ text: passage.text, truncated: passage.truncated, top, left });
  }, [contentRef, scrollRef]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    if (!companion) return;
    const box = scrollRef.current;
    // Hidden while the mouse is still choosing the words, so the button does not chase the pointer.
    const down = (ev: PointerEvent) => {
      if (contentRef.current?.contains(ev.target as Node)) {
        dragging.current = true;
        setSpot(null);
      }
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      schedule();
    };
    // Escape puts the button away until the selection changes.
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !contentRef.current?.contains(sel.anchorNode)) return;
      dismissed.current = sel.toString();
      setSpot(null);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("keydown", key);
    box?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("keydown", key);
      box?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [companion, contentRef, scrollRef, schedule]);

  if (!companion || !spot) return null;

  const ask = () => {
    postToCompanion({
      type: "hub:selection",
      text: spot.text,
      truncated: spot.truncated,
      title: source.title,
      versionId: source.versionId,
      versionNumber: source.versionNumber,
      fileName: source.fileName ?? null,
      projectName: source.projectName ?? null,
    });
    dismissed.current = window.getSelection()?.toString() ?? null;
    setSpot(null);
  };

  return (
    <button
      type="button"
      // Keep the words selected: a click on the button must not clear them.
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={ask}
      className="fixed z-50 inline-flex items-center whitespace-nowrap gap-1.5 rounded-md border bg-popover px-2.5 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ top: spot.top, left: spot.left, height: BUTTON_H, maxWidth: BUTTON_W }}
      title="Adds this passage, quoted, to your message in the chat. Nothing is sent until you send it."
      data-testid="ask-claude-about-selection"
    >
      <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" />
      Ask Claude about this
    </button>
  );
}
