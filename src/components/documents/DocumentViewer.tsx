import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, FileQuestion, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToastAction } from "@/components/ui/toast";
import ChangesPanel from "@/components/ai/chat/ChangesPanel";
import { useToast } from "@/hooks/use-toast";
import { useVersionChangeState, useVersionChanges } from "@/hooks/useVersionChanges";
import { CleanCopyRefused, chatApiBase, downloadVersionFile, type ChangeCard } from "@/lib/documentSave";
import { clearOutline, outlineSuggestion } from "@/lib/locateInPreview";
import { changesTabLabel, opensOnChanges, showsChangesTab, viewerFileOf } from "@/lib/versionChangesRules";
import { cn } from "@/lib/utils";
import { extensionFor } from "./zipDownload";
import { sortVersions, versionOptionLabel, type PreviewVersion } from "./previewVersions";
import { VersionChecksPanel } from "./VersionChecksPanel";
import { VersionChangesPanel } from "./VersionChangesPanel";
import { scrollPreviewTo, useVersionInsights } from "./versionInsights";
import { VersionSummaryPanel } from "./VersionSummaryPanel";
import { AskClaudeAboutSelection, type CompanionSource } from "./AskClaudeAboutSelection";
import { fitScale, useFitSize } from "./fitWidth";

// Look at a project document without downloading it: Word files are drawn
// in the page, PDFs and images shown as they are, anything else offered as a
// download. The site's preview sheet and the AI workspace's document window
// both put this inside their own frame.
//
// Beside the document: Checks (blanks, references to nothing, numbers whose
// words and figures disagree, terms, numbering) and What changed (this
// version against the one before, clause by clause), both written by the
// server when it reads the version.
//
// In the companion's drawer (the Hub beside a claude.ai chat) the caller
// passes `companionSource`, the version's name and id, and highlighting a
// passage of a Word file offers "Ask Claude about this", which puts the
// passage in the chat's message box. On the pane page (the Claude desktop
// app's browser pane) the same button is "Copy for Claude", and the caller
// asks for `fitToWidth`: a Word file is drawn at its real page width and
// scaled to fit the pane, with a Fit / 100% switch beside Download.
// Beside a Claude chat (the drawer and the pane alike) the caller also asks
// for `compact`: the version, Download, Fit / 100% and the tabs share one
// row, so the document starts high in a short panel (a Windows laptop at
// 150% scaling has little height to spare), and a PDF opens fitted to the
// width without the browser's PDF toolbar (Download is on the row).
//
// A Word version marked up from claude.ai (the connector files the client's
// draft with the AI's tracked changes as the next version) also has
// Changes: the AI's changes as cards, each accepted or rejected here. The
// decisions are kept in a decided copy beside the version's own file, which
// is never rewritten; once there is one, the viewer draws it and Download
// offers it tracked or clean (chat-service/versionChanges.js). The tab is
// shown only for a version with change rows, and first while any wait.

// "changes" is What changed (the comparison); "tracked" is the Changes list.
type Tab = "document" | "summary" | "tracked" | "checks" | "changes";
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
  /** Only where Claude is the chat (the companion's drawer, the pane page): the version on show, so a highlighted passage can be handed to the chat. */
  companionSource?: CompanionSource;
  /** The pane page: draw a Word file at its page width, scaled to fit, with a Fit / 100% switch. */
  fitToWidth?: boolean;
  /** Beside a Claude chat: one row of controls, Download as an icon, a PDF fitted to the width without its toolbar. */
  compact?: boolean;
}

export function DocumentViewer({ document: doc, versions: given, versionId, onVersionChange, onDownload, heading, actions, note, headerClassName = "p-4", className, companionSource, fitToWidth = false, compact = false }: DocumentViewerProps) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; url: string | null }>({ loading: false, error: null, url: null });
  const docxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("document");
  // Fit the page to the pane, or show it at 100% (scrolling sideways).
  const [fit, setFit] = useState(true);

  const versions = sortVersions(given);
  const version = versions.find((v) => v.id === versionId) ?? versions[0] ?? null;
  const latest = versions[0] ?? null;
  const kind = version ? kindOf(version) : "none";
  const insights = useVersionInsights(version?.id);
  const checkable = version ? CHECKABLE_EXTENSIONS.includes(extensionFor(version)) : false;
  const earlier = version ? versions.filter((v) => v.version_number < version.version_number) : [];
  const checkTotal = insights.data?.proofCheck?.total;
  const comparedWith = insights.data?.changes?.previous?.version_number ?? earlier[0]?.version_number ?? null;
  const { toast } = useToast();

  // A Word version's change rows and decided copy, then (only when it has
  // rows) its Changes list from the chat service.
  const changeState = useVersionChangeState(kind === "docx" ? version?.id : undefined);
  const rowCount = changeState.data?.rowCount ?? 0;
  const changes = useVersionChanges(version?.id, { enabled: kind === "docx" && rowCount > 0 });
  const hasChanges = kind === "docx" && showsChangesTab({ rowCount, listed: changes.cards?.length });
  const showing: Tab = tab === "tracked" && !hasChanges ? "document" : tab;
  // The file drawn: the decided copy once a change has been decided here,
  // else the version's own. A Word file waits for the database to say which.
  const decidedPath = (changes.head?.decided ? changes.head.storagePath : null) ?? changeState.data?.head?.storage_path ?? null;
  const filePath = version ? viewerFileOf(version, decidedPath ? { storage_path: decidedPath } : null) : null;
  const fileReady = kind !== "docx" || !changeState.isLoading;
  const marked = kind === "docx" && (rowCount > 0 || !!decidedPath);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fitting = fitToWidth && kind === "docx";
  const fitSize = useFitSize(previewRef, docxRef, fitting);
  const scale = fitting && fit && fitSize ? fitScale(fitSize.available, fitSize.width) : 1;

  // The tab a version opens on: Changes while any of its changes wait,
  // unless the lawyer has already picked a tab for this version.
  const settledFor = useRef<string | null>(null);
  const chooseTab = (next: Tab) => {
    if (version) settledFor.current = version.id;
    setTab(next);
  };
  const listed = changes.list.data;
  useEffect(() => {
    if (!version || !listed || listed.versionId !== version.id || settledFor.current === version.id) return;
    settledFor.current = version.id;
    if (opensOnChanges(listed.counts)) setTab("tracked");
  }, [version?.id, listed]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server may have finished reading since the viewer opened.
  const { reload } = insights;
  useEffect(() => {
    if (showing === "checks" || showing === "changes") reload();
  }, [showing, reload]);

  // Show a finding in the Word preview: switch to it, then find the words.
  const findInDocument = (text: string) => {
    chooseTab("document");
    return scrollPreviewTo(docxRef.current, text);
  };

  // Show a change's card in the Word preview: switch to it, then outline the words.
  const showCard = (card: ChangeCard) => {
    setSelectedId(card.id);
    chooseTab("document");
    // The page is shown on the next paint; find the passage once it is.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const frame = previewRef.current;
        if (!frame) return;
        if (outlineSuggestion(frame, card.before || null, card.after || null, { accepted: card.state === "accepted" })) return;
        const placed = card.state === "waiting" || card.state === "accepted" || card.state === "rejected";
        toast({
          title: "Couldn't find this passage in the document",
          description: placed ? "Its wording is on the card. The page may lay it out differently." : card.stateNote ?? "Nothing in the file was changed for this one.",
        });
      }),
    );
  };

  // A marked-up version's file comes from the chat service, tracked or
  // clean; without the service only the file as it stands can be offered.
  const downloadMarked = async (form: "tracked" | "clean", acceptOthers = false) => {
    if (!version) return;
    try {
      if (!chatApiBase()) {
        if (form === "clean") throw new Error("A clean copy needs the firm's chat service, which isn't set up on this site.");
        onDownload({ ...version, storage_path: filePath ?? version.storage_path });
        return;
      }
      await downloadVersionFile(version.id, form, { acceptOthers });
    } catch (err) {
      if (err instanceof CleanCopyRefused) {
        toast({
          title: "The clean copy isn't ready",
          description: err.message,
          action: err.onlyOthers ? (
            <ToastAction altText="Download a clean copy with their changes accepted too" onClick={() => void downloadMarked("clean", true)}>
              Accept theirs too
            </ToastAction>
          ) : undefined,
        });
        return;
      }
      toast({ title: "Couldn't download the file", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const container = docxRef.current;
    if (container) container.innerHTML = "";
    if (previewRef.current) clearOutline(previewRef.current);
    setState({ loading: kind !== "none", error: null, url: null });
    if (!fileReady || !filePath) return;
    (async () => {
      try {
        if (kind === "docx") {
          const { data, error } = await supabase.storage.from("matter-documents").download(filePath);
          if (error || !data) throw error ?? new Error("The file couldn't be fetched.");
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !docxRef.current) return;
          await renderAsync(data, docxRef.current, docxRef.current, {
            inWrapper: true,
            // At its page width when it is to be fitted; reflowed to the width otherwise on a narrow screen.
            ignoreWidth: !fitToWidth && window.innerWidth < 640,
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
  }, [version?.id, kind, filePath, fileReady]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!version) return null;

  const tabs = (
    <Tabs value={showing} onValueChange={(v) => chooseTab(v as Tab)}>
      <TabsList className={cn("justify-start overflow-x-auto", compact ? "h-8" : "h-9 w-full sm:w-auto")}>
        <TabsTrigger value="document" className="text-xs">Document</TabsTrigger>
        <TabsTrigger value="summary" className="text-xs" data-testid="version-summary-tab">Summary</TabsTrigger>
        {hasChanges && (
          <TabsTrigger value="tracked" className="text-xs" data-testid="version-changes-tab">
            {changesTabLabel(changes.counts?.waiting)}
          </TabsTrigger>
        )}
        <TabsTrigger value="checks" className="text-xs">
          Checks{typeof checkTotal === "number" ? ` (${checkTotal})` : ""}
        </TabsTrigger>
        <TabsTrigger value="changes" className="text-xs">
          What changed
          {/* Four tabs do not fit a narrow drawer with the comparison named. */}
          {comparedWith !== null && <span className={cn(compact ? "hidden" : hasChanges && "hidden sm:inline")}>&nbsp;(vs v{comparedWith})</span>}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} data-testid="document-viewer">
      <div className={cn("border-b", compact ? "space-y-1.5" : "space-y-3", headerClassName)}>
        {heading}
        <div className={cn("flex flex-wrap items-center", compact ? "gap-1.5" : "gap-2")}>
          {/* On the pane page the version shares its line with Download and Fit / 100%. */}
          <Select value={version.id} onValueChange={onVersionChange}>
            <SelectTrigger
              className={cn("h-8 text-xs", compact ? "w-auto min-w-[6.5rem] max-w-[12rem]" : fitToWidth ? "min-w-[8rem] flex-1 sm:max-w-[20rem]" : "w-full sm:w-auto sm:min-w-[12rem] sm:max-w-[20rem]")}
              aria-label="Version"
              title={compact ? version.file_name ?? undefined : undefined}
            >
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
          {marked ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className={cn(compact && "h-8 px-2")} data-testid="version-download" title="Download" aria-label="Download">
                  <Download className={cn("h-4 w-4", !compact && "mr-1.5")} />{!compact && "Download"}
                  <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => void downloadMarked("tracked")}>With tracked changes</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadMarked("clean")}>Clean copy</DropdownMenuItem>
                {decidedPath && <DropdownMenuItem onSelect={() => onDownload(version)}>v{version.version_number} as filed, before any decision</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" variant="outline" className={cn(compact && "h-8 w-8 p-0")} onClick={() => onDownload(version)} title="Download" aria-label="Download">
              <Download className={cn("h-4 w-4", !compact && "mr-1.5")} />{!compact && "Download"}
            </Button>
          )}
          {fitting && !state.loading && !state.error && (
            <div className="inline-flex h-8 items-center rounded-md border p-0.5" role="group" aria-label="Page size" data-testid="fit-toggle">
              {([
                [true, "Fit", "Fit the page to the width"],
                [false, "100%", "The page at full size"],
              ] as const).map(([value, label, title]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setFit(value)}
                  aria-pressed={fit === value}
                  title={title}
                  className={cn(
                    "h-full rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    fit === value ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {actions}
          {checkable && compact && tabs}
        </div>
        {note}
        {decidedPath && (
          <p className="text-xs text-muted-foreground" data-testid="decided-copy-note">
            Shown with the decisions made so far. v{version.version_number} as filed is kept unchanged.
          </p>
        )}
        {checkable && !compact && tabs}
      </div>

      {hasChanges && showing === "tracked" && (
        <div className="flex-1 min-h-0 flex flex-col" data-testid="version-changes">
          <ChangesPanel
            cards={changes.cards}
            counts={changes.counts}
            loading={changes.loading}
            error={changes.error}
            available={changes.available}
            deciding={changes.deciding}
            selectedId={selectedId}
            onSelect={showCard}
            onDecide={changes.decide}
            onReload={() => {
              void changes.reload();
              void changeState.refetch();
            }}
            emptyText="Nothing in this version is waiting to be decided here."
            unavailableText="Deciding these changes needs the firm's chat service, which isn't set up on this site. They are in the Word file as tracked changes: download it to decide them in Word."
          />
        </div>
      )}

      {showing === "summary" && (
        <div className="flex-1 min-h-0 overflow-auto bg-muted/40">
          <VersionSummaryPanel card={insights.data?.card ?? null} loading={insights.loading} />
        </div>
      )}
      {checkable && showing === "checks" && (
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
      {checkable && showing === "changes" && (
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
      {/* A fitted page keeps the scrollbar's room reserved, so its showing up does not change the width and the scale with it. */}
      <div ref={previewRef} className={`relative flex-1 min-h-0 overflow-auto bg-muted/40${fitToWidth ? " [scrollbar-gutter:stable]" : ""}${showing === "document" || (!checkable && showing !== "summary") ? "" : " hidden"}`}>
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
        {kind === "docx" && !fitToWidth && <div ref={docxRef} className="min-h-full [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-2 sm:[&_.docx-wrapper]:p-6 max-sm:[&_section.docx]:!px-3 max-sm:[&_section.docx]:!py-4" />}
        {/* Fitted (the pane page): the pages keep their own width and margins and are scaled down as one; the outer box takes the scaled size so the scrolling matches what is seen. overflow: clip, not hidden, so scrolling to a finding scrolls the pane and not this box. */}
        {kind === "docx" && fitToWidth && (
          <div
            className="mx-auto overflow-clip"
            style={fitSize ? { width: Math.floor(fitSize.width * scale), height: Math.ceil(fitSize.height * scale) } : undefined}
            data-testid="fit-box"
            data-scale={scale.toFixed(3)}
          >
            <div
              ref={docxRef}
              className="w-max origin-top-left [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-3"
              style={scale !== 1 ? { transform: `scale(${scale})` } : undefined}
            />
          </div>
        )}
        {/* Straight after the drawn file, so Tab from a selection reaches it. */}
        {kind === "docx" && companionSource && !state.loading && !state.error && (
          <AskClaudeAboutSelection contentRef={docxRef} scrollRef={previewRef} source={companionSource} />
        )}
        {kind === "pdf" && state.url && (
          <iframe src={compact ? `${state.url}#toolbar=0&view=FitH` : state.url} title={doc.title} className="h-full w-full border-0 bg-background" />
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
