import { useEffect } from "react";

// Tells the companion (hub-companion/, the Chrome extension that shows the Hub
// beside a claude.ai chat) when the lawyer is in the middle of something, so
// a document Claude mentions is offered as a link ("Show it") instead of
// switching the page under them. Busy means any of:
// - typing: a focused field with text in it (an empty focused field is not);
// - an open dialog or menu;
// - a piece of work a hook or helper has begun and not yet ended: an upload
//   or drop being read, a Changes decision in flight, a download being made.
// The companion hears {type:"hub:busy", busy:true} the moment one starts and
// busy:false about 1.5 s after the last one ends, and only when that changes.
// Outside the companion nothing is ever posted: begin/end just count.

export const BUSY_IDLE_DELAY_MS = 1500;

type Timer = ReturnType<typeof setTimeout>;

export interface BusyTrackerOptions {
  idleDelay?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/** A counter of busy reasons and a debounced poster; nothing is posted until connect(). */
export function createBusyTracker({ idleDelay = BUSY_IDLE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }: BusyTrackerOptions = {}) {
  let held = 0;
  const flags = new Set<string>();
  let post: ((busy: boolean) => void) | null = null;
  let posted = false;
  let timer: Timer | null = null;

  const isBusy = () => held > 0 || flags.size > 0;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const sync = () => {
    if (!post) return;
    if (isBusy()) {
      cancel();
      if (!posted) {
        posted = true;
        post(true);
      }
    } else if (posted && timer === null) {
      timer = setTimer(() => {
        timer = null;
        if (post && posted && !isBusy()) {
          posted = false;
          post(false);
        }
      }, idleDelay);
    }
  };

  return {
    isBusy,
    /** One piece of work starts; call the returned function (any number of times) when it ends. */
    begin(): () => void {
      held++;
      sync();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        held--;
        sync();
      };
    },
    /** A named state the page watches itself (typing, an open dialog), on or off. */
    setFlag(name: string, on: boolean) {
      if (on === flags.has(name)) return;
      if (on) flags.add(name);
      else flags.delete(name);
      sync();
    },
    /** Starts posting changes; the returned function stops, saying "not busy" if it last said busy. */
    connect(poster: (busy: boolean) => void): () => void {
      post = poster;
      posted = false;
      sync();
      return () => {
        cancel();
        if (post === poster && posted) poster(false);
        if (post === poster) post = null;
        posted = false;
      };
    },
  };
}

export type BusyTracker = ReturnType<typeof createBusyTracker>;

const tracker = createBusyTracker();

/** Marks a piece of work as begun; returns its end. Counts outside the companion too, but posts nothing there. */
export function beginCompanionBusy(): () => void {
  return tracker.begin();
}

/** Runs a piece of async work as busy from start to finish. */
export async function whileCompanionBusy<T>(work: () => Promise<T>): Promise<T> {
  const end = tracker.begin();
  try {
    return await work();
  } finally {
    end();
  }
}

/** Busy while `active` is true (an upload list in progress, say). */
export function useCompanionBusy(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return tracker.begin();
  }, [active]);
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** A focused field with something typed in it. */
export function isTypingIn(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return el.value.trim() !== "";
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type) && el.value.trim() !== "";
  if (el instanceof HTMLElement && el.isContentEditable) return (el.textContent ?? "").trim() !== "";
  return false;
}

// Radix marks its open dialogs, sheets, popovers, menus and listboxes this way.
const OPEN_OVERLAY = ['[role="dialog"][data-state="open"]', '[role="alertdialog"][data-state="open"]', '[role="menu"][data-state="open"]', '[role="listbox"][data-state="open"]'].join(", ");

/**
 * Starts telling the companion: watches the page for typing and open
 * dialogs or menus, and posts every change of the busy state with `post`.
 * Returns the stop function. Called once, from the layout's companion branch.
 */
export function startCompanionBusy(post: (message: Record<string, unknown>) => void): () => void {
  let pending: Timer | null = null;
  const check = () => {
    pending = null;
    tracker.setFlag("typing", isTypingIn(document.activeElement));
    tracker.setFlag("overlay", !!document.querySelector(OPEN_OVERLAY));
  };
  // Many events and mutations arrive together: check once after them.
  const schedule = () => {
    if (pending === null) pending = setTimeout(check, 0);
  };
  const events = ["focusin", "focusout", "input", "change"] as const;
  for (const e of events) document.addEventListener(e, schedule, true);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  const disconnect = tracker.connect((busy) => post({ type: "hub:busy", busy }));
  check();
  return () => {
    for (const e of events) document.removeEventListener(e, schedule, true);
    observer.disconnect();
    if (pending !== null) clearTimeout(pending);
    tracker.setFlag("typing", false);
    tracker.setFlag("overlay", false);
    disconnect();
  };
}
