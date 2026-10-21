import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Clock, FileArchive, FileText, FolderUp, Loader2, MessageSquare, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDocumentTypes, type MatterDocumentRow, type MatterDocumentVersion } from "@/hooks/useMatterDocuments";
import type { ChatAttachment } from "@/hooks/useChat";
import { useProjectZip } from "@/hooks/useProjectZip";
import { attachmentForVersion, groupDocumentsByCategory } from "@/lib/projectFiles";
import { READ_STATE_LABEL, readStateHint, versionReadState, type ReadState } from "@/lib/documentReadState";
import { indexViaEdgeFunction, requestIndexing } from "@/lib/saveDraftToMatter";
import { DocumentDropZone } from "@/components/documents/DocumentDropZone";
import { DocumentIntakePanel } from "@/components/documents/DocumentIntakePanel";
import { plainUploadError } from "@/components/documents/uploadErrors";
import { useDocumentIntake, type IntakeDocument } from "@/components/documents/useDocumentIntake";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import CopyForClaude from "@/ai/components/CopyForClaude";

const NO_DOCUMENTS: IntakeDocument[] = [];

// The read-state badge on a phone is an icon alone, so a row stays one line.
const READ_STATE_ICON: Record<ReadState, typeof Check> = {
  searchable: Check,
  waiting: Clock,
  reading: Loader2,
  failed: AlertTriangle,
  unsupported: Ban,
};

interface ProjectFilesPanelProps {
  matterId: string;
  matterName?: string;
  documents: MatterDocumentRow[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** The version in the document window, if any. */
  activeVersionId?: string | null;
  onOpenVersion?: (versionId: string) => void;
  /** Put these in the prompt box. Without it there is no "Use in chat". */
  onUseInChat?: (attachments: ChatAttachment[]) => void;
  /**
   * In the companion's drawer, where the chat is claude.ai's: each version
   * is a link to its own page (/ai/d/<id>) and each file carries a small
   * "Copy for Claude" instead of anything that starts a Hub chat.
   */
  companion?: { projectName: string };
}

// The project's files in the AI workspace: grouped by the kind of document,
// each with its newest version, whether the AI can read it, and its date.
// Tick several to download them as one zip or put them in the prompt box.
// Files can be dropped anywhere on the panel; the same intake as the
// project page on the site checks them and uploads on Start.
export default function ProjectFilesPanel({ matterId, matterName, documents, isLoading, error, onRetry, activeVersionId, onOpenVersion, onUseInChat, companion }: ProjectFilesPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: documentTypes } = useDocumentTypes();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [readingVersions, setReadingVersions] = useState<Set<string>>(() => new Set());
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { zipProgress, downloadLatestOf } = useProjectZip({ projectName: matterName });

  // Re-evaluated every minute, so a version stuck "Reading…" for ten
  // minutes turns into "Couldn't be read" without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const markReading = (versionId: string, on: boolean) =>
    setReadingVersions((prev) => {
      const next = new Set(prev);
      if (on) next.add(versionId);
      else next.delete(versionId);
      return next;
    });
  const refreshDocuments = () => {
    queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    queryClient.invalidateQueries({ queryKey: ["project-search"] });
  };
  const intake = useDocumentIntake({
    matterId,
    documents: documents ?? NO_DOCUMENTS,
    onSaved: refreshDocuments,
    onReading: markReading,
  });
  // "Try again" on a version that couldn't be read: the same steps as the
  // site's project page. With the index worker this only queues the version
  // (the badge then follows the server); before that migration it runs the
  // old in-request reading and shows "Reading…" meanwhile.
  const readAgain = async (doc: MatterDocumentRow, version: MatterDocumentVersion) => {
    const label = `v${version.version_number} of "${doc.title}"`;
    let queued: Awaited<ReturnType<typeof requestIndexing>> | "error";
    try {
      queued = await requestIndexing(version.id);
    } catch {
      queued = "error";
    }
    if (queued !== "missing") {
      if (queued === "error") {
        toast({ title: `Couldn't ask for ${label} to be read`, description: "Check your connection and press Try again.", variant: "destructive" });
      } else if (queued === "queued") {
        toast({ title: `Reading ${label} again`, description: "It will show as Searchable when it is done; you can carry on working." });
      }
      refreshDocuments();
      return;
    }
    markReading(version.id, true);
    try {
      const indexed = await indexViaEdgeFunction({
        versionId: version.id,
        matterId,
        documentTypeId: doc.document_type_id ?? null,
        storagePath: version.storage_path,
        fileName: version.file_name ?? version.storage_path.split("/").pop() ?? "document",
      });
      toast(
        indexed
          ? { title: `${label} is now searchable`, description: "Search and Ask AI can read it." }
          : { title: `Couldn't read ${label}`, description: "The file is saved and can be downloaded. Press Try again next to it, or upload it as a PDF or Word file.", variant: "destructive" },
      );
    } catch (err) {
      toast({ title: `Couldn't read ${label}`, description: plainUploadError(err), variant: "destructive" });
    } finally {
      markReading(version.id, false);
      refreshDocuments();
    }
  };

  const takeFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) intake.addFiles(files);
  };

  const groups = useMemo(() => groupDocumentsByCategory(documents ?? [], documentTypes ?? []), [documents, documentTypes]);
  const readState = (v: MatterDocumentVersion): ReadState => (readingVersions.has(v.id) ? "reading" : versionReadState(v, now));

  // Only documents still in the project count (one may have been removed since it was ticked).
  const selectedDocs = (documents ?? []).filter((d) => selected.has(d.id));
  const toggle = (docId: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(docId);
      else next.delete(docId);
      return next;
    });
  const toggleExpanded = (docId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  const useSelectedInChat = () => {
    if (!onUseInChat) return;
    const attachments = selectedDocs.flatMap((d) => {
      const latest = groups.flatMap((g) => g.documents).find((row) => row.doc.id === d.id)?.latest;
      return latest ? [attachmentForVersion(d, latest)] : [];
    });
    onUseInChat(attachments);
    setSelected(new Set());
  };

  const total = documents?.length ?? 0;

  return (
    <DocumentDropZone onDrop={intake.addDrop} className="rounded-2xl">
      <section className="rounded-2xl border bg-card" data-testid="project-files">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <h2 className="text-sm font-medium">Files{total ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{total}</span> : null}</h2>
          <div className="flex-1" />
          <Button size="sm" variant="outline" className="h-8" onClick={() => bulkFileInputRef.current?.click()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />Add files
          </Button>
          <Button size="sm" variant="ghost" className="hidden h-8 sm:inline-flex" onClick={() => folderInputRef.current?.click()} title="Upload a whole folder">
            <FolderUp className="mr-1.5 h-3.5 w-3.5" />Folder
          </Button>
          <input ref={bulkFileInputRef} type="file" multiple className="hidden" onChange={takeFiles} />
          <input
            ref={(el) => {
              folderInputRef.current = el;
              // Not in React's typings; lets the picker choose a whole folder.
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            className="hidden"
            onChange={takeFiles}
          />
        </div>

        <div className="space-y-3 px-4 pb-4 pt-2">
          <DocumentIntakePanel intake={intake} />
          {zipProgress && (
            <div className="space-y-1.5 rounded-md border px-3 py-2" aria-live="polite">
              <p className="text-xs">
                {zipProgress.phase === "fetching"
                  ? `Collecting ${zipProgress.what}: ${zipProgress.done} of ${zipProgress.total} file${zipProgress.total === 1 ? "" : "s"}…`
                  : "Packing the .zip file…"}
              </p>
              <Progress value={zipProgress.percent} className="h-2" />
            </div>
          )}
          {selectedDocs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/60 px-3 py-2" data-testid="files-bulk-bar">
              <span className="text-xs font-medium">{selectedDocs.length} selected</span>
              {onUseInChat && (
                <Button size="sm" className="h-7 text-xs" onClick={useSelectedInChat} data-testid="use-in-chat">
                  <MessageSquare className="mr-1.5 h-3.5 w-3.5" />Use in chat
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={!!zipProgress}
                onClick={() => void downloadLatestOf(selectedDocs, `${selectedDocs.length} selected document${selectedDocs.length === 1 ? "" : "s"}`)}
              >
                <FileArchive className="mr-1.5 h-3.5 w-3.5" />Download zip
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          <LoadState
            isLoading={isLoading}
            error={error}
            onRetry={onRetry}
            what="files"
            compact
            isEmpty={total === 0}
            empty={
              <div className="rounded-xl border border-dashed px-4 py-6 text-center" data-testid="files-empty">
                <Upload className="mx-auto h-5 w-5 text-muted-foreground" />
                <p className="mt-2 text-sm">No files yet</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Drop files, folders or .zip files here, or press Add files. Nothing is uploaded until you press Start.</p>
              </div>
            }
          >
            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.category}>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.category}</div>
                  <ul className="divide-y rounded-xl border">
                    {group.documents.map(({ doc, latest, typeName }) => {
                      const versions = [...(doc.versions ?? [])].sort((a, b) => b.version_number - a.version_number);
                      const state = latest ? readState(latest as MatterDocumentVersion) : null;
                      const isOpen = !!latest && !!activeVersionId && versions.some((v) => v.id === activeVersionId);
                      const isExpanded = expanded.has(doc.id);
                      return (
                        <li key={doc.id} className={cn("px-2 py-1.5", isOpen && "bg-accent/60")} data-testid="file-row">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              className="shrink-0"
                              checked={selected.has(doc.id)}
                              disabled={!latest}
                              onCheckedChange={(checked) => toggle(doc.id, checked === true)}
                              aria-label={`Select "${doc.title}"`}
                            />
                            {companion && latest ? (
                              <Link to={`/ai/d/${latest.id}`} className="group flex min-w-0 flex-1 items-center gap-2 text-left" title="Open" data-testid="file-link">
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm group-hover:underline">{doc.title}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">
                                    v{latest.version_number}
                                    {latest.label ? ` · ${latest.label}` : ""}
                                    {typeName ? ` · ${typeName}` : ""}
                                    {` · ${new Date(latest.created_at).toLocaleDateString()}`}
                                  </span>
                                </span>
                              </Link>
                            ) : (
                            <button
                              type="button"
                              className="group flex min-w-0 flex-1 items-center gap-2 text-left"
                              title={latest ? "Open" : "No file yet"}
                              onClick={() => (latest ? onOpenVersion?.(latest.id) : toggleExpanded(doc.id))}
                            >
                              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm group-hover:underline">{doc.title}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {latest ? `v${latest.version_number}` : "No file yet"}
                                  {typeName ? ` · ${typeName}` : ""}
                                  {latest ? ` · ${new Date(latest.created_at).toLocaleDateString()}` : ""}
                                </span>
                              </span>
                            </button>
                            )}
                            {latest && state && (
                              <ReadStateBadge version={latest as MatterDocumentVersion} state={state} />
                            )}
                            {latest && state === "failed" && (
                              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => void readAgain(doc, latest as MatterDocumentVersion)} data-testid="read-again">
                                Try again
                              </Button>
                            )}
                            {companion && latest && (
                              <CopyForClaude compact title={doc.title} versionId={latest.id} versionNumber={latest.version_number} fileName={latest.file_name} projectName={companion.projectName} />
                            )}
                            {versions.length > 1 && (
                              <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" title={isExpanded ? "Hide older versions" : `${versions.length} versions`} onClick={() => toggleExpanded(doc.id)}>
                                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                          {isExpanded && versions.length > 1 && (
                            <ul className="mt-1 space-y-0.5 pl-10">
                              {versions.map((v) => (
                                <li key={v.id}>
                                  {companion ? (
                                    <Link to={`/ai/d/${v.id}`} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent">
                                      <span className="font-medium">v{v.version_number}</span>
                                      <span className="truncate text-muted-foreground">{v.label || v.file_name || ""}</span>
                                      <span className="ml-auto shrink-0 text-muted-foreground">{new Date(v.created_at).toLocaleDateString()}</span>
                                    </Link>
                                  ) : (
                                  <button type="button" className={cn("flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent", v.id === activeVersionId && "bg-accent")} onClick={() => onOpenVersion?.(v.id)}>
                                    <span className="font-medium">v{v.version_number}</span>
                                    <span className="truncate text-muted-foreground">{v.label || v.file_name || ""}</span>
                                    <span className="ml-auto shrink-0 text-muted-foreground">{new Date(v.created_at).toLocaleDateString()}</span>
                                  </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </LoadState>
        </div>
      </section>
    </DocumentDropZone>
  );
}

// Whether the AI can read this version: the words from sm up, the icon
// alone on a phone, with the full hint on both.
function ReadStateBadge({ version, state }: { version: MatterDocumentVersion; state: ReadState }) {
  const Icon = READ_STATE_ICON[state];
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1 px-1.5 text-[10px] font-normal sm:px-2.5",
        state === "failed" && "border-amber-500 text-amber-700 dark:text-amber-400",
        state === "searchable" && "text-muted-foreground",
      )}
      title={readStateHint(version, state)}
      aria-label={READ_STATE_LABEL[state]}
      data-testid="read-state"
      data-read-state={state}
    >
      <Icon className={cn("h-3 w-3", state === "reading" && "animate-spin", state !== "reading" && "sm:hidden")} aria-hidden />
      <span className="hidden sm:inline">{READ_STATE_LABEL[state]}</span>
    </Badge>
  );
}
