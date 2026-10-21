import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// What the pane page's bar (src/ai/layout/PaneBar.tsx) shows: the page on
// screen says what it is with usePaneBar, and the bar reads it back.

export interface PaneBarInfo {
  /** The page's name in the bar: "<document> · v<n>", or the project's name. */
  title?: string;
  /** Where the back arrow goes; no arrow when unset. */
  backTo?: string;
  /** What the back arrow is called, for a screen reader and the tooltip. */
  backLabel?: string;
  /** What "Copy for Claude" puts on the clipboard; no button when unset. */
  copy?: string;
  /** The button's tooltip. */
  copyTitle?: string;
}

interface PaneBarValue {
  info: PaneBarInfo | null;
  setInfo: (info: PaneBarInfo | null) => void;
}

export const PaneBarContext = createContext<PaneBarValue | null>(null);

export function PaneBarProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<PaneBarInfo | null>(null);
  const value = useMemo(() => ({ info, setInfo }), [info]);
  return <PaneBarContext.Provider value={value}>{children}</PaneBarContext.Provider>;
}

/** Tells the pane's bar what this page is, while it is on screen. Does nothing outside the pane page (or the workspace). */
export function usePaneBar(info: PaneBarInfo | null) {
  const setInfo = useContext(PaneBarContext)?.setInfo;
  const { title, backTo, backLabel, copy, copyTitle } = info ?? {};
  const given = info !== null;
  useEffect(() => {
    if (!setInfo || !given) return;
    setInfo({ title, backTo, backLabel, copy, copyTitle });
    return () => setInfo(null);
  }, [setInfo, given, title, backTo, backLabel, copy, copyTitle]);
}
