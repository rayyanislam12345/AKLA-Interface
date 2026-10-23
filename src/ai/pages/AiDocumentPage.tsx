import { friendlyError } from "@/lib/friendlyError";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, MessageSquare, PencilLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { editTargetOf, useDocumentVersion } from "@/hooks/useDocumentVersion";
import { attachParam } from "@/lib/projectSeeds";
import { useEmbedHost, useEmbedMode } from "@/lib/embedMode";
import { versionForClaudeText } from "@/lib/copyForClaude";
import { useAiPageTitle } from "@/ai/AiWorkspaceContext";
import { usePaneBar } from "@/ai/layout/paneBarContext";
import { useOpenEditChat } from "@/ai/useOpenEditChat";
import SiteLink from "@/ai/components/SiteLink";
import { DocumentViewer } from "@/components/documents/DocumentViewer";
import { downloadStoredVersion } from "@/components/documents/downloadVersion";
import { versionDownloadName } from "@/components/documents/zipDownload";
import { Button } from "@/components/ui/button";

// A stored project version, full page (/ai/d/:versionId): the same viewer
// as the document window, with room to read. "Ask about this" goes to the
// project page with the file in the prompt box; "Edit with AI" opens it in
// a chat of its own. In the companion's panel (embed mode) the layout's own
// header already names the document, so the page's bar is left out and the
// project's name goes on the line under it. Framed by the companion, the chat
// is claude.ai's: "Copy for Claude" replaces the two Hub-chat buttons.
// On the pane page (?host=pane, the Claude desktop app's browser pane) Claude
// is the chat too, and the pane's bar carries the name, Back to the project
// and "Copy for Claude": the page keeps one line of detail, the version and
// Download, and draws a Word file at its page width, scaled to fit. The
// companion shows the same bar (src/ai/layout/PaneBar.tsx), so there too the
// bar carries "Copy for Claude" and the page does not repeat it.
// Both beside a chat, the page is the same too: no line of detail (the bar
// names the document and version, Back names the project, the file's name is
// on the version's tooltip), one compact row of controls and tabs, and the
// page fitted to the width, Word and PDF alike.
export default function AiDocumentPage() {
  const { versionId } = useParams<{ versionId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const embed = useEmbedMode();
  const host = useEmbedHost();
  const companion = host === "companion";
  // Claude is the chat here (the companion's drawer or the pane): no Hub chat buttons.
  const claudeChat = host !== null;
  const openEdit = useOpenEditChat();
  const { data: detail, isLoading, error, refetch } = useDocumentVersion(versionId);
  useAiPageTitle(detail?.document.title ?? "Document");

  const projectPath = detail ? `/ai/p/${detail.document.matter_id}` : "/ai";
  usePaneBar(
    claudeChat && detail
      ? {
          title: `${detail.document.title} · v${detail.version.version_number}`,
          backTo: projectPath,
          backLabel: detail.matter?.name ? `Back to ${detail.matter.name}` : "Back to the project",
          copy: versionForClaudeText(
            { title: detail.document.title, versionId: detail.version.id, versionNumber: detail.version.version_number, fileName: detail.version.file_name, projectName: detail.matter?.name },
            window.location.origin,
          ),
          copyTitle: "Copies this version's name, id and Hub link, to paste into your Claude message",
        }
      : null,
  );
  const back = () => {
    // Back where the lawyer came from when there is somewhere to go back to
    // (the router numbers its entries); the project page for a pasted link.
    // In the companion's drawer there are no entries to go back through
    // (src/lib/companionHistory.ts): the project page then too.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0 && !companion) navigate(-1);
    else navigate(projectPath);
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="ai-document-loading">Opening…</div>
    );
  }
  if (error && !detail) {
    return (
      <Notice title="This document couldn't be loaded" body="Check your connection and try again.">
        <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
      </Notice>
    );
  }
  if (!detail) {
    return (
      <Notice title="This document isn't available" body="It may have been deleted, or it belongs to a project you can't see.">
        <Button asChild variant="outline" size="sm"><Link to="/ai">Home</Link></Button>
      </Notice>
    );
  }

  const download = async (v: { storage_path: string; version_number: number; label: string | null; file_name: string | null }) => {
    try {
      await downloadStoredVersion(v.storage_path, versionDownloadName(detail.document.title, v));
    } catch (err) {
      toast({ title: "Couldn't download the file", description: friendlyError(err), variant: "destructive" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-document-page">
      {!embed && (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2 md:px-4">
          <Button variant="ghost" size="sm" className="h-8" onClick={back} aria-label="Back">
            <ArrowLeft className="h-4 w-4 md:mr-1.5" />
            <span className="hidden md:inline">Back</span>
          </Button>
          <div className="min-w-0 flex-1 truncate px-1 text-sm">
            <span className="font-medium">{detail.document.title}</span>
            {detail.matter?.name && (
              <>
                <span className="text-muted-foreground"> · </span>
                <Link to={projectPath} className="text-muted-foreground hover:text-foreground hover:underline">{detail.matter.name}</Link>
              </>
            )}
          </div>
          <SiteLink
            to={`/matters/${detail.document.matter_id}?document=${detail.document.id}#version-${detail.version.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open on Project Hub"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open on Project Hub</span>
            <span className="sm:hidden">Project Hub</span>
          </SiteLink>
        </div>
      )}
      <div className={claudeChat ? "flex w-full min-h-0 flex-1 flex-col" : "mx-auto flex w-full max-w-[72rem] min-h-0 flex-1 flex-col"}>
        <DocumentViewer
          document={detail.document}
          versions={detail.versions}
          versionId={detail.version.id}
          onVersionChange={(id) => navigate(`/ai/d/${id}`, { replace: true })}
          onDownload={download}
          fitToWidth={claudeChat}
          compact={claudeChat}
          companionSource={
            claudeChat
              ? { title: detail.document.title, versionId: detail.version.id, versionNumber: detail.version.version_number, fileName: detail.version.file_name, projectName: detail.matter?.name }
              : undefined
          }
          headerClassName={claudeChat ? "px-2 py-1.5" : embed ? "px-3 py-2.5" : "px-4 py-3 md:px-6"}
          heading={
            claudeChat ? undefined : <p className="break-words text-xs text-muted-foreground" title={detail.version.file_name ?? undefined}>
              {embed && detail.matter?.name && (
                <>
                  <Link to={projectPath} className="hover:text-foreground hover:underline" title="The project's page: its files, chats and instructions">{detail.matter.name}</Link>
                  {" · "}
                </>
              )}
              {detail.version.file_name ?? `Version ${detail.version.version_number}`} · added {new Date(detail.version.created_at).toLocaleDateString()}
              {detail.version.is_ai_generated ? " · written with AI" : ""}
            </p>
          }
          actions={
            claudeChat ? null : (
            <>
              <Button size="sm" onClick={() => navigate(`${projectPath}?attach=${attachParam(detail.version.id)}`)} data-testid="ask-about-version">
                <MessageSquare className="mr-1.5 h-4 w-4" />Ask about this
              </Button>
              <Button size="sm" variant="outline" onClick={() => void openEdit(detail.document.matter_id, editTargetOf(detail))} data-testid="edit-version">
                <PencilLine className="mr-1.5 h-4 w-4" />Edit with AI
              </Button>
            </>
            )
          }
        />
      </div>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="ai-document-notice">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}
