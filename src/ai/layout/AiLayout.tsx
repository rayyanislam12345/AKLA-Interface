import { useEffect, useLayoutEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Menu, SquarePen } from "lucide-react";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import { useTheme } from "next-themes";
import { useIsMobile } from "@/hooks/use-mobile";
import { AiWorkspaceProvider, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import AiSidebar from "@/ai/layout/AiSidebar";
import { enterDarkOnlyMode, isDarkOnlyAiTheme } from "@/ai/theme";
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
  const { mobileSidebarOpen, setMobileSidebarOpen, pageTitle, sidebarCollapsed, aiTheme } = useAiWorkspace();
  const { theme, setTheme } = useTheme();
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
