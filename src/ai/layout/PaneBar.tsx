import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, ExternalLink, MoreHorizontal, X } from "lucide-react";
import { useAiWorkspace } from "@/ai/AiWorkspaceContext";
import { CopyTextForClaude } from "@/ai/components/CopyForClaude";
import { Button } from "@/components/ui/button";
import { postToCompanion, withoutEmbed } from "@/lib/embedMode";
import { PaneBarContext } from "@/ai/layout/paneBarContext";

// The pane page's bar (?embed=1&host=pane: the Hub in the Claude desktop
// app's browser pane, opened from one of the connector's "Open in Hub"
// links). Nothing else draws a bar there, so this one line does it all: a
// back arrow (a document goes back to its project), the page's name, "Copy
// for Claude" for the page, and "Full Hub", the same page in the ordinary
// Hub in a new tab. The page on show tells the bar what it is with
// usePaneBar; until it does the bar shows the workspace's page title.
// The companion (the Chrome extension, ?host=companion) shows this same bar,
// so the two read and work alike; it adds two buttons of the extension's at
// the right end: "⋯", the extension's menu (paste a link, colours, where the
// Hub shows, settings), and, in the drawer inside the chat page, Close. Both
// are messages to the extension, which does the work.

interface Props {
  /** In the companion: its menu, and Close when the extension can close (the drawer, not Chrome's side panel). */
  companion?: { closable: boolean };
}

export default function PaneBar({ companion }: Props = {}) {
  const location = useLocation();
  const { pageTitle } = useAiWorkspace();
  const info = useContext(PaneBarContext)?.info ?? null;
  const title = info?.title || pageTitle;
  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-1 border-b bg-background px-1.5" data-testid="ai-pane-bar">
      {info?.backTo ? (
        <Button asChild variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <Link to={info.backTo} aria-label={info.backLabel ?? "Back"} title={info.backLabel ?? "Back"} data-testid="pane-back">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
      ) : (
        <span className="w-1.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1 truncate text-sm font-medium" title={title} data-testid="pane-title">{title}</div>
      {info?.copy && (
        <CopyTextForClaude
          text={() => info.copy ?? ""}
          title={info.copyTitle ?? "Copies this page's name, id and Hub link, to paste into your Claude message"}
          className="h-8 shrink-0 px-2.5 text-xs"
        />
      )}
      <a
        href={withoutEmbed(location)}
        target="_blank"
        rel="noopener"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        title="The same page in the full Hub, in a new tab"
        aria-label="Full Hub"
        data-testid="open-full-hub"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        <span className="hidden min-[380px]:inline">Full Hub</span>
      </a>
      {companion && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => postToCompanion({ type: "hub:menu" })}
          title="More: paste a link, colours, where the Hub shows, settings"
          aria-label="More"
          aria-haspopup="menu"
          data-testid="companion-menu"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      )}
      {companion?.closable && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => postToCompanion({ type: "hub:close" })}
          title="Close the Hub beside the chat"
          aria-label="Close"
          data-testid="companion-close"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </header>
  );
}
