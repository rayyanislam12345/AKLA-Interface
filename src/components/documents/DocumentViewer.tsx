import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, FileQuestion, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { extensionFor } from "./zipDownload";
import { sortVersions, versionOptionLabel, type PreviewVersion } from "./previewVersions";
import { VersionChecksPanel } from "./VersionChecksPanel";
import { VersionChangesPanel } from "./VersionChangesPanel";
import { scrollPreviewTo, useVersionInsights } from "./versionInsights";

// Look at a project document without downloading it: Word files are drawn
// in the page, PDFs and images shown as they are, anything else offered as a
// download. The site's preview sheet and the AI workspace's document window
// both put this inside their own frame.
//
// Beside the document: Checks (blanks, references to nothing, numbers whose
// words and figures disagree, terms, numbering) and What changed (this
// version against the one before, clause by clause), both written by the
// server when it reads the version.

type Tab = "document" | "checks" | "changes";
const CHECKABLE_EXTENSIONS = ["docx", "pdf", "txt", "md"];

export type { PreviewVersion } from "./previewVersions";

type Kind = "docx" | "pdf" | "image" | "none";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

function kindOf(v: PreviewVersion): Kind {
  const ext = extensionFor(v);
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "none";
}

export interface DocumentViewerProps {
  document: { id: string; title: string };
  versions: PreviewVersion[];
  /** The version on show; the newest when it names none of them. */
  versionId: string;
  onVersionChange: (versionId: string) => void;
  onDownload: (version: PreviewVersion) => void;
  /** Rendered first in the header: the frame's title block. */
  heading?: ReactNode;
  /** More buttons after Download, on the same row. */
  actions?: ReactNode;
  /** A line under the controls: the sheet's note about an older version. */
  note?: ReactNode;
  /** The header's padding; the sheet leaves room for its close button. */
  headerClassName?: string;
  className?: string;
}

export function DocumentViewer({ document: doc, versions: given, versionId, onVersionChange, onDownload, heading, actions, note, headerClassName = "p-4", className }: DocumentViewerProps) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; url: string | null }>({ loading: false, error: null, url: null });
  const docxRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("document");

  const versions = sortVersions(given);
  const version = versions.find((v) => v.id === versionId) ?? versions[0] ?? null;
  const latest = versions[0] ?? null;
  const kind = version ? kindOf(version) : "none";
  const insights = useVersionInsights(version?.id);
  const checkable = version ? CHECKABLE_EXTENSIONS.includes(extensionFor(version)) : false;
  const earlier = version ? versions.filter((v) => v.version_number < version.version_number) : [];
  const checkTotal = insights.data?.proofCheck?.total;
  const comparedWith = insights.data?.changes?.previous?.version_number ?? earlier[0]?.version_number ?? null;

  // The server may have finished reading since the viewer opened.
  const { reload } = insights;
  useEffect(() => {
    if (tab !== "document") reload();
  }, [tab, reload]);

  // Show a finding in the Word preview: switch to it, then find the words.
  const findInDocument = (text: string) => {
    setTab("document");
    return scrollPreviewTo(docxRef.current, text);
  };

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const container = docxRef.current;
    if (container) container.innerHTML = "";
    setState({ loading: kind !== "none", error: null, url: null });
    (async () => {
      try {
        if (kind === "docx") {
          const { data, error } = await supabase.storage.from("matter-documents").download(version.storage_path);
          if (error || !data) throw error ?? new Error("The file couldn't be fetched.");
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !docxRef.current) return;
          await renderAsync(data, docxRef.current, docxRef.current, {
            inWrapper: true,
            ignoreWidth: window.innerWidth < 640,
            renderChanges: true,
            renderComments: false,
          });
          if (!cancelled) setState({ loading: false, error: null, url: null });
        } else if (kind === "pdf" || kind === "image") {
          const { data, error } = await supabase.storage.from("matter-documents").createSignedUrl(version.storage_path, 60 * 60);
          if (error || !data?.signedUrl) throw error ?? new Error("The file couldn't be fetched.");
          if (!cancelled) setState({ loading: false, error: null, url: data.signedUrl });
        }
      } catch {
        if (!cancelled) setState({ loading: false, error: "This file couldn't be shown here. You can still download it.", url: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version?.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!version) return null;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} data-testid="document-viewer">
      <div className={cn("border-b space-y-3", headerClassName)}>
        {heading}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={version.id} onValueChange={onVersionChange}>
            <SelectTrigger className="h-8 w-full sm:w-auto sm:min-w-[12rem] sm:max-w-[20rem] text-xs" aria-label="Version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.id} className="text-xs">
                  {versionOptionLabel(v)}{v.id === latest?.id ? " (latest)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => onDownload(version)}>
            <Download className="h-4 w-4 mr-1.5" />Download
          </Button>
          {actions}
        </div>
        {note}
        {checkable && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList className="h-9 w-full sm:w-auto justify-start overflow-x-auto">
              <TabsTrigger value="document" className="text-xs">Document</TabsTrigger>
              <TabsTrigger value="checks" className="text-xs">
                Checks{typeof checkTotal === "number" ? ` (${checkTotal})` : ""}
              </TabsTrigger>
              <TabsTrigger value="changes" className="text-xs">
                What changed{comparedWith !== null ? ` (vs v${comparedWith})` : ""}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>

      {checkable && tab === "checks" && (
        <div className="flex-1 min-h-0 overflow-auto bg-muted/40">
          <VersionChecksPanel
            versionId={version.id}
            versionNumber={version.version_number}
            checkable={checkable}
            insights={insights.data}
            loading={insights.loading}
            loadError={insights.error}
            onFind={kind === "docx" && !state.error ? findInDocument : undefined}
          />
        </div>
      )}
      {checkable && tab === "changes" && (
        <div className="flex-1 min-h-0 overflow-auto bg-muted/40">
          <VersionChangesPanel
            documentTitle={doc.title}
            version={version}
            versions={versions}
            comparable={checkable}
            insights={insights.data}
            loading={insights.loading}
            loadError={insights.error}
          />
        </div>
      )}

      {/* Kept mounted on the other tabs so the drawn Word file survives a tab switch. */}
      <div className={`relative flex-1 min-h-0 overflow-auto bg-muted/40${tab === "document" || !checkable ? "" : " hidden"}`}>
        {state.loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />Opening…
          </div>
        )}
        {state.error && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">{state.error}</p>
            <Button size="sm" onClick={() => onDownload(version)}><Download className="h-4 w-4 mr-1.5" />Download</Button>
          </div>
        )}
        {/* docx-preview writes the Word page margins (an inch each side) as inline padding on each section; below the sm breakpoint (a phone, or the companion's side panel) that would leave about 150px for the text, so the margins are overridden there. */}
        {kind === "docx" && <div ref={docxRef} className="min-h-full [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-2 sm:[&_.docx-wrapper]:p-6 max-sm:[&_section.docx]:!px-3 max-sm:[&_section.docx]:!py-4" />}
        {kind === "pdf" && state.url && (
          <iframe src={state.url} title={doc.title} className="h-full w-full border-0 bg-background" />
        )}
        {kind === "image" && state.url && (
          <div className="flex justify-center p-4">
            <img src={state.url} alt={doc.title} className="max-w-full h-auto shadow" />
          </div>
        )}
        {kind === "none" && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
            <FileQuestion className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No preview for this file type.</p>
            <Button size="sm" onClick={() => onDownload(version)}><Download className="h-4 w-4 mr-1.5" />Download</Button>
          </div>
        )}
      </div>
    </div>
  );
}
