import { useLayoutEffect, useState, type RefObject } from "react";

// Fit to width, for the pane page (?host=pane): a Word file is drawn at its
// real page width and then scaled down with a CSS transform until the page
// fits the pane, so it reads as the page it is. A transform leaves the text
// selectable, and the selection's rectangles (getClientRects) come back in
// screen pixels, so "Copy for Claude" by a selection and the outline round a
// change still land in the right place.

/** The smallest scale offered: below it the words are too small to read. */
export const MIN_FIT_SCALE = 0.3;

/** The scale that fits `natural` pixels into `available`: never above 1, never below MIN_FIT_SCALE; 1 when either is unknown. */
export function fitScale(available: number, natural: number): number {
  if (!(available > 0) || !(natural > 0)) return 1;
  return Math.min(1, Math.max(MIN_FIT_SCALE, available / natural));
}

export interface FitSize {
  /** The drawn pages' own width and height, before any scaling. */
  width: number;
  height: number;
  /** The width the scrolling box has for them. */
  available: number;
}

/**
 * The drawn content's own size and the room its scrolling box gives it,
 * kept up to date as either changes (the pane is resized, the file finishes
 * drawing). Null while `on` is false.
 */
export function useFitSize(boxRef: RefObject<HTMLElement>, contentRef: RefObject<HTMLElement>, on: boolean): FitSize | null {
  const [size, setSize] = useState<FitSize | null>(null);
  useLayoutEffect(() => {
    if (!on) {
      setSize(null);
      return;
    }
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const measure = () => {
      // offsetWidth/offsetHeight are the layout's sizes, which a transform does not change.
      const next = { width: content.offsetWidth, height: content.offsetHeight, available: box.clientWidth };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height && prev.available === next.available ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [on, boxRef, contentRef]);
  return size;
}
