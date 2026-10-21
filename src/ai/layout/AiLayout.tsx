import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ExternalLink, Menu, SquarePen } from "lucide-react";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import { useTheme } from "next-themes";
import { useIsMobile } from "@/hooks/use-mobile";
import { AiWorkspaceProvider, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import AiSidebar from "@/ai/layout/AiSidebar";
import { enterDarkOnlyMode, isAiThemeId, isDarkOnlyAiTheme } from "@/ai/theme";
import { EMBED_PARAM, isCompanionOrigin, companionHref, postToCompanion, resolveCompanionHost, useEmbedMode, withoutEmbed } from "@/lib/embedMode";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// The AI workspace at /ai: its own shell, without the site's navy sidebar
// and header. The `ai-app` class scopes the workspace's colours (see
// index.css) to this subtree; it goes on <body> too while this is mounted,
// because menus and dialogs render in portals outside the subtree. The
// chosen colour theme rides along as data-ai-theme on both.
// The viewport is told to fill an iPhone's screen edge to edge only while
// the workspace is open (its chat pads for the home indicator); the site's
// own pages keep the viewport they were built for.
// Opened with ?embed=1 (the companion's side panel beside a claude.ai chat,
// see src/lib/embedMode.ts) there is no sidebar at all: a one-line header
// names the place and links to the same page in the ordinary Hub. When the
// companion frames it with ?host=companion, the companion's own bar does that
// job, so there is no header at all: the page posts its address and name to
// the companion instead, and takes the chat's colour theme from it.
export default function AiLayout() {
  useEffect(() => {
    document.body.classList.add("ai-app");
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = viewport?.getAttribute("content") ?? null;
    if (viewport && before && !/viewport-fit/.test(before)) viewport.setAttribute("content", `${before}, viewport-fit=cover`);
    return () => {
      document.body.classList.remove("ai-app");
      if (viewport && before !== null) viewport.setAttribute("content", before);
    };
  }, []);
  return (
    <AiWorkspaceProvider>
      <AiShell />
    </AiWorkspaceProvider>
  );
}

function AiShell() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const embed = useEmbedMode();
  const companion = embed && resolveCompanionHost(location.search);
  const { mobileSidebarOpen, setMobileSidebarOpen, pageTitle, sidebarCollapsed, aiTheme, setAiTheme } = useAiWorkspace();
  useEffect(() => {
    if (!companion) return;
    postToCompanion({ type: "hub:location", href: companionHref(location), title: pageTitle });
  }, [companion, location, pageTitle]);
  useEffect(() => {
    if (!companion) return;
    const onMessage = (ev: MessageEvent) => {
      if (!isCompanionOrigin(ev.origin) || ev.source !== window.parent) return;
      const d = ev.data as { type?: unknown; aiTheme?: unknown } | null;
      if (d && d.type === "companion:theme" && isAiThemeId(d.aiTheme)) setAiTheme(d.aiTheme);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [companion, setAiTheme]);
  const { theme, setTheme } = useTheme();
  // ?embed=0 has done its work (the mode is off): take it out of the address.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get(EMBED_PARAM) !== "0") return;
    params.delete(EMBED_PARAM);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);
  // Mirrored on <body> before paint so portals (menus, dialogs, sheets)
  // are in the same theme as the page.
  useLayoutEffect(() => {
    document.body.setAttribute("data-ai-theme", aiTheme);
    return () => {
      document.body.removeAttribute("data-ai-theme");
    };
  }, [aiTheme]);
  // Night and Monokai hold their dark tokens on their own, but the chat's
  // other dark styles (prose-invert, the amber notices) follow next-themes'
  // .dark class. Keep the mode pinned to dark while one of them is chosen:
  // on load with a saved choice, and if the mode ever drifts (a "Device"
  // setting whose device turns light, or the site's own toggle).
  useEffect(() => {
    if (isDarkOnlyAiTheme(aiTheme)) enterDarkOnlyMode(theme, setTheme);
  }, [aiTheme, theme, setTheme]);
  if (embed) {
    return (
      <div className="ai-app flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground" data-ai-theme={aiTheme} data-testid="ai-app" data-embed="1">
        {!companion && <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3" data-testid="ai-embed-bar">
          <div className="min-w-0 flex-1 truncate text-sm font-medium" title={pageTitle}>{pageTitle}</div>
          <a
            href={withoutEmbed(location)}
            target="_blank"
            rel="noopener"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title="The same page in the Hub, in a new tab"
            data-testid="open-in-hub"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in the Hub
          </a>
        </header>}
        <main className="relative flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    );
  }
  return (
    <div className="ai-app flex h-dvh w-full overflow-hidden bg-background text-foreground" data-ai-theme={aiTheme} data-testid="ai-app">
      {isMobile ? (
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <AiSidebar variant="sheet" />
          </SheetContent>
        </Sheet>
      ) : (
        <aside className={cn("shrink-0 border-r border-sidebar-border transition-[width] duration-200", sidebarCollapsed ? "w-14" : "w-64 xl:w-72")}>
          <AiSidebar variant="rail" />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {isMobile && (
          <header className="flex h-12 shrink-0 items-center gap-1 border-b px-1" data-testid="ai-mobile-bar">
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setMobileSidebarOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1 truncate text-center text-sm font-medium">{pageTitle}</div>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => navigate("/ai")} aria-label="New chat">
              <SquarePen className="h-5 w-5" />
            </Button>
          </header>
        )}
        <main className="relative flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
