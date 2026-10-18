import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { type ChatArtifact, useSendChatMessage } from "@/hooks/useChat";
import { type AiThemeId, readAiTheme, saveAiTheme } from "@/ai/theme";

// What the whole AI workspace shares, whichever page is showing: the one
// chat engine (so a reply being written carries on when the lawyer moves
// from one page to another — the turns live here, not in a page), the
// document panel on the right, and the sidebar's state.

export type AiPanel =
  | { kind: "artifact"; artifactId: string; threadId: string }
  | { kind: "version"; versionId: string }
  | null;

export const NEW_CHAT_PATH = "/ai/c/new";
const SIDEBAR_KEY = "ai-sidebar-collapsed";

interface AiWorkspaceValue {
  chat: ReturnType<typeof useSendChatMessage>;
  panel: AiPanel;
  setPanel: (panel: AiPanel) => void;
  openArtifact: (artifact: ChatArtifact) => void;
  /** A stored project version in the document window (?open=v:<id>). */
  openVersion: (versionId: string) => void;
  closePanel: () => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  // The workspace's colour theme (see src/ai/theme.ts); read from
  // localStorage before the first render so there is no flash.
  aiTheme: AiThemeId;
  setAiTheme: (theme: AiThemeId) => void;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  // What the phone's top bar shows for the page that is open.
  pageTitle: string;
  setPageTitle: (title: string) => void;
  // Chats whose handed-over document has already been opened once, so
  // closing the panel sticks when the lawyer comes back to the chat.
  autoOpenedThreads: Set<string>;
}

const AiWorkspaceContext = createContext<AiWorkspaceValue | null>(null);

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function AiWorkspaceProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  // The chat a "new" page has just been given an id for: its first document
  // may arrive before the address has caught up.
  const justCreatedRef = useRef<string | null>(null);

  const [panel, setPanelState] = useState<AiPanel>(null);
  const setPanel = useCallback((next: AiPanel) => setPanelState(next), []);
  const openArtifact = useCallback((artifact: ChatArtifact) => {
    setPanelState({ kind: "artifact", artifactId: artifact.id, threadId: artifact.thread_id });
  }, []);
  const openVersion = useCallback((versionId: string) => setPanelState({ kind: "version", versionId }), []);
  const closePanel = useCallback(() => setPanelState(null), []);
  // A document window belongs to the page it was opened on (a chat's own
  // artifact panel comes back when the lawyer returns to that chat, so it
  // stays); a stored version closes when the page changes. A layout effect,
  // so it runs before the new page's own effects open what its address asks
  // for (?open=v:), and only on a change, not on the first page.
  const lastPathRef = useRef(location.pathname);
  useLayoutEffect(() => {
    if (lastPathRef.current === location.pathname) return;
    lastPathRef.current = location.pathname;
    setPanelState((p) => (p?.kind === "version" ? null : p));
  }, [location.pathname]);

  const chat = useSendChatMessage(
    (threadId) => {
      // The first message of a new chat gives it a row: move the address
      // onto it so a refresh lands back here. Unless the lawyer has already
      // gone elsewhere: then the new chat keeps writing in the background
      // and shows up in Recents.
      justCreatedRef.current = threadId;
      if (pathRef.current === NEW_CHAT_PATH) navigate(`/ai/c/${threadId}`, { replace: true });
    },
    (artifact) => {
      const onThatChat = pathRef.current === `/ai/c/${artifact.thread_id}` || (pathRef.current === NEW_CHAT_PATH && justCreatedRef.current === artifact.thread_id);
      if (onThatChat) openArtifact(artifact);
    },
  );

  const [sidebarCollapsed, setSidebarCollapsedState] = useState(readCollapsed);
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* a private window: the choice lasts for the session */
    }
  }, []);
  const [aiTheme, setAiThemeState] = useState<AiThemeId>(readAiTheme);
  const setAiTheme = useCallback((theme: AiThemeId) => {
    setAiThemeState(theme);
    saveAiTheme(theme);
  }, []);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Moving to another page closes the phone's sidebar sheet.
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  const [pageTitle, setPageTitle] = useState("AI workspace");
  const autoOpenedThreads = useRef(new Set<string>()).current;

  const value = useMemo<AiWorkspaceValue>(
    () => ({ chat, panel, setPanel, openArtifact, openVersion, closePanel, sidebarCollapsed, setSidebarCollapsed, aiTheme, setAiTheme, mobileSidebarOpen, setMobileSidebarOpen, pageTitle, setPageTitle, autoOpenedThreads }),
    [chat, panel, setPanel, openArtifact, openVersion, closePanel, sidebarCollapsed, setSidebarCollapsed, aiTheme, setAiTheme, mobileSidebarOpen, pageTitle, autoOpenedThreads],
  );
  return <AiWorkspaceContext.Provider value={value}>{children}</AiWorkspaceContext.Provider>;
}

export function useAiWorkspace(): AiWorkspaceValue {
  const ctx = useContext(AiWorkspaceContext);
  if (!ctx) throw new Error("useAiWorkspace must be used inside the AI workspace");
  return ctx;
}

/** Sets what the phone's top bar shows while this page is open. */
export function useAiPageTitle(title: string) {
  const { setPageTitle } = useAiWorkspace();
  useEffect(() => {
    setPageTitle(title);
  }, [title, setPageTitle]);
}
