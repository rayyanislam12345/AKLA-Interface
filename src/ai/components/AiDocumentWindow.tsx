import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FileText, Loader2, MessageSquare, PencilLine, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ChatArtifact, ChatAttachment, EditTarget } from "@/hooks/useChat";
import type { LawUpdate } from "@/hooks/useLawUpdates";
import { attachmentOf, editTargetOf, useDocumentVersion } from "@/hooks/useDocumentVersion";
import type { WorkingDocData } from "@/lib/documentSaveRules";
import ArtifactPanel from "@/components/ai/chat/ArtifactPanel";
import { DocumentViewer } from "@/components/documents/DocumentViewer";
import { VersionChecksPanel } from "@/components/documents/VersionChecksPanel";
import { VersionChangesPanel } from "@/components/documents/VersionChangesPanel";
import { useVersionInsights } from "@/components/documents/versionInsights";
import { downloadStoredVersion } from "@/components/documents/downloadVersion";
import { versionDownloadName } from "@/components/documents/zipDownload";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// The document window on the right of the AI workspace. Two things open in
// it: a document the chat produced (a draft, a Word file with its changes, a
// review), shown as the chat's own panel; and a stored project version,
// shown by the same viewer the project page's preview uses, with "Ask about
// this" and "Edit with AI".

export type AiDocumentWindowProps =
  | {
      kind: "artifact";
      artifact: ChatArtifact;
      matterId?: string;
      matterName?: string;
      lawUpdate?: LawUpdate | null;
      onClose: () => void;
    }
  | {
      kind: "version";
      versionId: string;
      onClose: () => void;
      /** Another version of the same document was picked. */
      onVersionChange?: (versionId: string) => void;
      /** Put this version in the prompt box. */
      onAsk?: (attachment: ChatAttachment, detail: { matterId: string; matterName: string | null }) => void;
      /** Open this version in an Edit chat. */
      onEdit?: (target: EditTarget, matterId: string) => void;
    };

export default function AiDocumentWindow(props: AiDocumentWindowProps) {
  if (props.kind === "artifact") return <ArtifactWindow {...props} />;
  return <VersionWindow {...props} />;
}

// ------------------------------------------------------------ artifact

type ArtifactTab = "document" | "checks" | "changes";

/** The stored version a chat document stands for: the one it was saved as, else the one it was opened from. */
function artifactVersionId(artifact: ChatArtifact): string | null {
  if (!["docx", "draft", "memo"].includes(artifact.kind)) return null;
  const data = (artifact.data ?? {}) as WorkingDocData;
  if (data.savedVersionId) return data.savedVersionId;
  if (data.editSource && !data.editSource.standard) return data.editSource.documentVersionId ?? null;
  return null;
}

function ArtifactWindow({ artifact, matterId, matterName, lawUpdate, onClose }: Extract<AiDocumentWindowProps, { kind: "artifact" }>) {
  const versionId = artifactVersionId(artifact);
  const [tab, setTab] = useState<ArtifactTab>("document");
  const showing = versionId ? tab : "document";
  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="ai-document-window">
      {versionId && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Tabs value={showing} onValueChange={(v) => setTab(v as ArtifactTab)}>
            <TabsList className="h-8">
              <TabsTrigger value="document" className="text-xs">Document</TabsTrigger>
              <TabsTrigger value="checks" className="text-xs">Checks</TabsTrigger>
              <TabsTrigger value="changes" className="text-xs">What changed</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          {/* The chat's own panel carries its close button only on the Document tab; these stay on every tab. */}
          <Button asChild variant="ghost" size="icon" className="h-7 w-7" title="Open full page">
            <Link to={`/ai/d/${versionId}`} aria-label="Open full page">
              <ExternalLink className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close document">
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {/* The chat's panel stays mounted on the other tabs so the editor keeps its place. */}
      <div className={cn("min-h-0 flex-1", showing !== "document" && "hidden")}>
        <ArtifactPanel matterId={matterId} matterName={matterName} artifact={artifact} lawUpdate={lawUpdate ?? null} onClose={onClose} />
      </div>
      {versionId && showing !== "document" && <SavedVersionInsights versionId={versionId} tab={showing} onClose={onClose} />}
    </div>
  );
}

// Checks and What changed for the saved version behind a chat document.
function SavedVersionInsights({ versionId, tab, onClose }: { versionId: string; tab: "checks" | "changes"; onClose: () => void }) {
  const { data: detail, isLoading } = useDocumentVersion(versionId);
  const insights = useVersionInsights(versionId);
  if (isLoading) return <Loading />;
  if (!detail) {
    return (
      <Unavailable onClose={onClose} body="The saved version this document stands for is no longer in the project." />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/40">
      {tab === "checks" ? (
        <VersionChecksPanel versionId={versionId} versionNumber={detail.version.version_number} checkable insights={insights.data} loading={insights.loading} loadError={insights.error} />
      ) : (
        <VersionChangesPanel documentTitle={detail.document.title} version={detail.version} versions={detail.versions} comparable insights={insights.data} loading={insights.loading} loadError={insights.error} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- version

function VersionWindow({ versionId, onClose, onVersionChange, onAsk, onEdit }: Extract<AiDocumentWindowProps, { kind: "version" }>) {
  const { toast } = useToast();
  const { data: detail, isLoading, error, refetch } = useDocumentVersion(versionId);
  // Another version picked in the viewer, when the page does not take over.
  const [picked, setPicked] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error && !detail) {
    return (
      <Unavailable onClose={onClose} title="This document couldn't be loaded" body="Check your connection and try again.">
        <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
      </Unavailable>
    );
  }
  if (!detail) return <Unavailable onClose={onClose} body="It may have been deleted, or it belongs to a project you can't see." />;

  const shownId = picked ?? detail.version.id;
  const shown = detail.versions.find((v) => v.id === shownId) ?? detail.version;
  const shownDetail = { ...detail, version: { ...detail.version, ...shown } };
  const download = async (v: { storage_path: string; version_number: number; label: string | null; file_name: string | null }) => {
    try {
      await downloadStoredVersion(v.storage_path, versionDownloadName(detail.document.title, v));
    } catch (err) {
      toast({ title: "Couldn't download the file", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="ai-document-window">
      <DocumentViewer
        document={detail.document}
        versions={detail.versions}
        versionId={shownId}
        onVersionChange={(id) => (onVersionChange ? onVersionChange(id) : setPicked(id))}
        onDownload={download}
        headerClassName="px-3 py-2.5"
        heading={
          <div className="flex items-start gap-2">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={detail.document.title}>{detail.document.title}</div>
              <div className="truncate text-xs text-muted-foreground" title={shown.file_name ?? undefined}>
                v{shown.version_number}{shown.label ? ` · ${shown.label}` : ""} · added {new Date(shown.created_at).toLocaleDateString()}
                {detail.matter?.name ? ` · ${detail.matter.name}` : ""}
              </div>
            </div>
            <Button asChild variant="ghost" size="icon" className="h-7 w-7" title="Open full page">
              <Link to={`/ai/d/${shown.id}`} aria-label="Open full page">
                <ExternalLink className="h-4 w-4" />
              </Link>
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close document">
              <X className="h-4 w-4" />
            </Button>
          </div>
        }
        actions={
          <>
            {onAsk && (
              <Button size="sm" onClick={() => onAsk(attachmentOf(shownDetail), { matterId: detail.document.matter_id, matterName: detail.matter?.name ?? null })} data-testid="ask-about-version">
                <MessageSquare className="mr-1.5 h-4 w-4" />Ask about this
              </Button>
            )}
            {onEdit && (
              <Button size="sm" variant="outline" onClick={() => onEdit(editTargetOf(shownDetail), detail.document.matter_id)} data-testid="edit-version">
                <PencilLine className="mr-1.5 h-4 w-4" />Edit with AI
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="ai-document-loading">
      <Loader2 className="h-4 w-4 animate-spin" /> Opening…
    </div>
  );
}

function Unavailable({ title = "This document isn't available", body, onClose, children }: { title?: string; body: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="ai-document-unavailable">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        {children}
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
