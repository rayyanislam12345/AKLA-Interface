import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { renderAsync } from "docx-preview";
import { fitDocxPreview } from "@/lib/fitDocxPreview";
import { acceptTrackedChanges, stripComments } from "@/lib/docxAccept";
import { clearOutline, outlineSuggestion, suggestionAtPoint } from "@/lib/locateInPreview";
import { AlertTriangle, BadgeCheck, ChevronDown, ChevronRight, Download, FileText, Loader2, MessageSquare, Save, Settings2 } from "lucide-react";
import type { ChatArtifact } from "@/hooks/useChat";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { useChatFile, useUploadDocumentTypeTemplate } from "@/hooks/useDocumentTypeTemplates";
import { type WorkingDocument, useProjectDocumentLatest } from "@/hooks/useDocumentChanges";
import {
  chatApiBase,
  CleanCopyRefused,
  downloadBlob,
  downloadWorkingDocument,
  patchArtifactKeys,
  saveWorkingDocument,
  setAutoSave,
  useAutoSavePreference,
  useAutoSaveStatus,
  type ChangeCard,
} from "@/lib/documentSave";
import { saveButtonLabel, saveStateOf, saveTargetFor, waitingOf, type WorkingDocData } from "@/lib/documentSaveRules";
import { openSitePage } from "@/lib/embedMode";
import ChangesPanel from "@/components/ai/chat/ChangesPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useMyProfile } from "@/hooks/useProfiles";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import { cn } from "@/lib/utils";

interface DocxArtifactData extends WorkingDocData {
  bucket: string;
  storagePath: string;
  fileName: string;
  validation?: { placeholders?: Array<{ part: string; paragraph: number; text: string }>; format?: { status: string; findings: Array<{ detail: string; part: string }>; limitation: string } };
  changes?: Array<{ op: string; paragraph: number; status: string; summary: string; reason?: string }>;
  applied?: number;
  generatedBy?: string;
  rendered?: string;
  akla?: { status: string; findings: string[] };
  // Standardisation: when this copy was published as the type's standard.
  publishedAsStandardAt?: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Below this width the Changes list and the page do not fit side by side:
// the Changes tab shows the list alone, and a card opens the page.
const SIDE_BY_SIDE_PX = 760;

// A Word file the chat is working on: the version as uploaded, the firm's
// standard, or the AI's latest copy with its changes shown as Word tracked
// changes. Nothing here is rebuilt from text: the preview is the file, the
// download is the file, and saving to the project stores the file.
//
// `working` is the document behind the copy the panel was opened on; its
// head (newest copy) is what is shown, decided, downloaded and saved.
export default function DocxArtifact({
  matterId,
  standard,
  working,
}: {
  matterId?: string;
  standard?: { documentTypeId: string; documentTypeName: string };
  working: WorkingDocument;
}) {
  const { toast } = useToast();
  // Publishing a standard changes what every future draft of that type
  // starts from: an admin's call, not any member's.
  const { data: me } = useMyProfile();
  const isAdmin = me?.role === "admin" || me?.role === "founder";
  const uploadStandard = useUploadDocumentTypeTemplate();
  const [publishing, setPublishing] = useState(false);
  const head = working.head;
  const queryClient = useQueryClient();
  const data = (head.data ?? {}) as unknown as DocxArtifactData;
  const { data: blob, isLoading, error } = useChatFile(data.bucket ?? "ai-chat-files", data.storagePath);
  const frameRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [previewForm, setPreviewForm] = useState<"tracked" | "accepted">("tracked");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const waiting = waitingOf(working.counts);
  const total = working.counts?.total ?? 0;
  const [view, setView] = useState<"document" | "changes">(() => (total > 0 && !data.original ? "changes" : "document"));
  const [wide, setWide] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<ChangeCard | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWide(el.clientWidth >= SIDE_BY_SIDE_PX));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const showDocument = view === "document" || wide;
  const showChanges = view === "changes";

  const locate = (card: ChangeCard, { scroll = true, quiet = false }: { scroll?: boolean; quiet?: boolean } = {}) => {
    const frame = frameRef.current;
    if (!frame) return;
    const found = outlineSuggestion(frame, card.before || null, card.after || null, { scroll, accepted: card.state === "accepted" });
    if (found || quiet) return;
    clearOutline(frame);
    const placed = card.state === "waiting" || card.state === "accepted" || card.state === "rejected";
    toast({
      title: "Couldn't find this passage in the document",
      description: placed ? "Its wording is on the card. The page may lay it out differently." : card.stateNote ?? "Nothing in the file was changed for this one.",
    });
  };

  const selectCard = (card: ChangeCard) => {
    setSelectedId(card.id);
    selectedRef.current = card;
    if (!showDocument) {
      setView("document");
      // The page is shown on the next paint; find the passage once it is.
      requestAnimationFrame(() => requestAnimationFrame(() => locate(card)));
    } else {
      locate(card);
    }
  };

  // The card's state changes after a decision; the outline on the rebuilt
  // page has to know which wording the page now shows.
  useEffect(() => {
    if (selectedId) selectedRef.current = working.cards?.find((c) => c.id === selectedId) ?? selectedRef.current;
  }, [working.cards, selectedId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!blob || !frame) return;
    frame.innerHTML = "";
    let cancelled = false;
    let stopFitting = () => {};
    const render = async () => {
      const file = previewForm === "accepted" ? await acceptTrackedChanges(blob) : blob;
      if (cancelled || !frameRef.current) return;
      await renderAsync(file, frame, frame, { renderChanges: previewForm !== "accepted", inWrapper: true });
      if (cancelled) return;
      stopFitting = fitDocxPreview(frame);
      // A decision rebuilds the page; keep the chosen change marked.
      const selected = selectedRef.current;
      if (selected) requestAnimationFrame(() => !cancelled && locate(selected, { scroll: false, quiet: true }));
    };
    render().catch((err) => {
      toast({ title: "Couldn't show the Word file", description: errorText(err), variant: "destructive" });
    });
    return () => {
      cancelled = true;
      stopFitting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob, previewForm, toast]);

  // Clicking a change on the page opens its card.
  const handlePageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    const cards = working.cards;
    if (!frame || !cards?.length || window.getSelection()?.toString()) return;
    const placed = cards
      .filter((c) => c.state === "waiting" || c.state === "accepted")
      .map((c) => ({ id: c.id, original_text: c.before || null, suggested_text: c.after || null, card: c }));
    const hit = suggestionAtPoint(frame, event.target as Node, event.clientX, event.clientY, placed);
    if (!hit) return;
    setSelectedId(hit.id);
    selectedRef.current = hit.card;
    outlineSuggestion(frame, hit.original_text, hit.suggested_text, { scroll: false, accepted: hit.card.state === "accepted" });
    if (showChanges) listRef.current?.querySelector<HTMLElement>(`[data-change-id="${hit.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const handleDownload = async (form: "tracked" | "clean", acceptOthers = false) => {
    try {
      if (!chatApiBase()) {
        // Without the chat service only the file as it is can be offered.
        if (form === "clean") throw new Error("A clean copy needs the firm's chat service, which isn't set up on this site.");
        if (!blob) throw new Error("The file hasn't loaded yet.");
        downloadBlob(blob, data.fileName);
        return;
      }
      await downloadWorkingDocument(head.id, form, { acceptOthers });
    } catch (err) {
      if (err instanceof CleanCopyRefused) {
        toast({
          title: "The clean copy isn't ready",
          description: err.message,
          action: err.onlyOthers ? (
            <ToastAction altText="Download a clean copy with their changes accepted too" onClick={() => void handleDownload("clean", true)}>
              Accept theirs too
            </ToastAction>
          ) : undefined,
        });
        return;
      }
      toast({ title: "Download failed", description: errorText(err), variant: "destructive" });
    }
  };

  // The master becomes the firm's standard for the type: every change
  // accepted, the AKLA comments (guidance for the associate, not for a
  // client) stripped, and the file put through the same upload the
  // Standardize page uses, so the previous standard is kept as a version.
  const handleSetAsStandard = async () => {
    if (!standard || !blob || data.truncated) return;
    if (!window.confirm(`Set this file as the firm's standard for "${standard.documentTypeName}"? Every future draft of that type will start from it. The current standard is kept as an earlier version.`)) return;
    setPublishing(true);
    try {
      const clean = await stripComments(await acceptTrackedChanges(blob));
      const file = new File([clean], data.fileName, { type: clean.type });
      await uploadStandard.mutateAsync({ documentTypeId: standard.documentTypeId, file });
      await patchArtifactKeys(head.id, { publishedAsStandardAt: new Date().toISOString() })
        .then(() => queryClient.invalidateQueries({ queryKey: ["chat-artifacts", head.thread_id] }))
        .catch(() => {});
      toast({ title: `Set as the standard for ${standard.documentTypeName}`, description: data.fileName });
    } catch (err) {
      toast({ title: "Couldn't set the standard", description: errorText(err), variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  };

  // Comments have nothing to accept or reject, so they are not cards; they
  // stay in the copy's own summary. Without the Changes list (no chat
  // service) that summary is all there is, so it is shown whole.
  const summary = data.changes ?? [];
  const comments = working.available ? summary.filter((c) => c.op === "comment") : summary;

  const note = data.original
    ? "As uploaded"
    : data.generatedBy
      ? `Produced by /${data.generatedBy}`
      : data.standard
        ? "Filled in from the firm's standard"
        : data.rendered === "akla" && !total
          ? "AKLA house format"
          : null;

  const changesTab = total > 0 ? `Changes (${waiting} waiting)` : "Changes";

  return (
    <div className="flex h-full flex-col" ref={containerRef}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Document view">
          <button type="button" role="tab" aria-selected={view === "document"} onClick={() => setView("document")} className={cn("rounded px-2 py-1", view === "document" ? "bg-muted font-medium" : "text-muted-foreground")}>
            Document
          </button>
          <button type="button" role="tab" aria-selected={view === "changes"} onClick={() => setView("changes")} className={cn("rounded px-2 py-1", view === "changes" ? "bg-muted font-medium" : "text-muted-foreground")} data-testid="changes-tab">
            {changesTab}
          </button>
        </div>
        <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="docx-artifact-note" title={data.fileName}>
          {note ? `${note} · ` : ""}
          {data.fileName}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!data.original && (
            <Select value={previewForm} onValueChange={(v) => setPreviewForm(v as "tracked" | "accepted")}>
              <SelectTrigger className="h-8 w-48 max-w-full text-xs" data-testid="docx-form" aria-label="How the page is shown">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tracked">Tracked changes shown</SelectItem>
                <SelectItem value="accepted">Preview: all changes accepted</SelectItem>
              </SelectContent>
            </Select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8" aria-label="Download" disabled={!data.storagePath} data-testid="docx-download">
                <Download className="h-4 w-4" />
                <ChevronDown className="ml-0.5 h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void handleDownload("tracked")}>Download (tracked changes)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleDownload("clean")}>Download clean copy</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {working.isEarlierCopy && (
        <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground" data-testid="earlier-copy-note">
          You opened an earlier copy from the chat. This is the latest copy, with every change and decision so far.
        </p>
      )}

      {standard ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <Button size="sm" className="h-8" onClick={handleSetAsStandard} disabled={publishing || !blob || data.truncated || !isAdmin} title={isAdmin ? undefined : "Only an administrator can set the firm's standard"} data-testid="set-as-standard">
            {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BadgeCheck className="mr-2 h-4 w-4" />}
            Set as standard
          </Button>
          <span className="text-xs text-muted-foreground">
            {data.truncated
              ? "Complete this draft before setting it as the firm's standard."
              : data.publishedAsStandardAt
                ? `Set as the standard on ${new Date(data.publishedAsStandardAt).toLocaleString()}`
                : "Publishes a clean copy (changes accepted, AKLA comments removed) as the firm's standard for this type."}
          </span>
        </div>
      ) : (
        <SaveBar matterId={matterId} head={head} data={data} waiting={waiting} workingDocumentId={working.workingDocumentId ?? head.id} />
      )}

      {data.akla?.status === "needs_review" && (
        <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">House format check: needs review</p>
          {data.akla.findings.map((f, i) => <p key={i}>{f}</p>)}
        </div>
      )}
      {data.validation && (
        <div className="space-y-1 border-b p-3 text-xs" data-testid="docx-validation">
          <p className="font-medium">Document checks: {data.validation.format?.status === "checked" ? "source formatting preserved in checked properties" : "formatting needs review"}</p>
          <p>{data.validation.placeholders?.length ?? 0} unresolved placeholder occurrence(s).</p>
          {data.validation.placeholders?.slice(0, 12).map((p, i) => <p key={i}>{p.part}, paragraph {p.paragraph}: {p.text}</p>)}
          {data.validation.format?.findings.map((f, i) => <p key={i}>{f.part}: {f.detail}</p>)}
          <p className="text-muted-foreground">{data.validation.format?.limitation}</p>
        </div>
      )}
      {comments.length > 0 && (
        <div className="border-b px-3 py-2 text-xs">
          <button type="button" className="flex items-center gap-1 font-medium" onClick={() => setCommentsOpen((o) => !o)}>
            {commentsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <MessageSquare className="h-3.5 w-3.5" />
            {working.available ? `${comments.length} comment${comments.length === 1 ? "" : "s"} from the AI` : `${comments.length} change${comments.length === 1 ? "" : "s"} in this copy`}
          </button>
          {commentsOpen && (
            <ul className="mt-1.5 space-y-1" data-testid="docx-changes">
              {comments.map((c, i) => (
                <li key={i} className={cn("flex items-start gap-1.5", c.status !== "applied" && "text-muted-foreground")}>
                  {c.status !== "applied" && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />}
                  <span>
                    {c.summary}
                    {c.reason && <span className="italic"> ({c.reason})</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {showChanges && (
          <div ref={listRef} className={cn("flex min-h-0 flex-col border-r", wide ? "w-[340px] shrink-0" : "w-full")}>
            <ChangesPanel
              cards={working.cards}
              counts={working.counts}
              loading={working.loading}
              error={working.error}
              available={working.available}
              deciding={working.deciding}
              selectedId={selectedId}
              onSelect={selectCard}
              onDecide={working.decide}
              onReload={() => void working.reload()}
            />
          </div>
        )}
        {/* Kept laid out (not display:none) while the list has the room, so
            the page is measured and fitted at its real width. */}
        <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", !showDocument && "pointer-events-none absolute inset-0 -z-10 opacity-0")} aria-hidden={!showDocument}>
          {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading the Word file…</p>}
          {error && <p className="p-4 text-sm text-destructive">{errorText(error)}</p>}
          <div
            ref={frameRef}
            onClick={handlePageClick}
            className="docx-preview-container relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-muted/40 p-4 [&_del]:cursor-pointer [&_ins]:cursor-pointer"
            data-testid="docx-preview"
          />
        </div>
      </div>
    </div>
  );
}

// Where the document stands against the project, and the one button that
// saves it there. In a project chat, a copy that came from a project
// document is saved as its next version (automatically after each AI turn,
// unless switched off for this chat); anything else is offered as a new
// document. More options: a version label, or a new document with a type.
function SaveBar({ matterId, head, data, waiting, workingDocumentId }: { matterId?: string; head: ChatArtifact; data: DocxArtifactData; waiting: number; workingDocumentId: string }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: documentTypes } = useDocumentTypes();
  const projectId = matterId ?? head.matter_id ?? undefined;
  const target = saveTargetFor(data);
  const { data: latest } = useProjectDocumentLatest(target);
  const state = saveStateOf(data);
  const autoSave = useAutoSavePreference(head.thread_id, !!matterId && !!target);
  const autoStatus = useAutoSaveStatus(workingDocumentId);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [mode, setMode] = useState<"next-version" | "new-document">(target ? "next-version" : "new-document");
  const [label, setLabel] = useState("");
  const [documentTypeId, setDocumentTypeId] = useState<string | undefined>(data.documentTypeId ?? undefined);
  useEffect(() => {
    if (!target) setMode("new-document");
  }, [target]);

  const typesByCategory = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof documentTypes>>();
    for (const t of documentTypes ?? []) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
    return Array.from(groups.entries());
  }, [documentTypes]);

  // An uploaded file nobody has changed is saved from its chip in the chat.
  if (data.original && data.producedBy === "open") return null;

  const save = async (opts: { mode: "next-version" | "new-document"; label?: string; projectOverride?: string }) => {
    const project = opts.projectOverride ?? projectId;
    if (!project && opts.mode === "new-document") {
      setPickerOpen(true);
      return;
    }
    setSaving(true);
    try {
      const result = await saveWorkingDocument({
        artifact: head,
        matterId: project,
        mode: opts.mode,
        label: opts.label?.trim() || undefined,
        documentTypeId: opts.mode === "new-document" ? documentTypeId ?? null : undefined,
        queryClient,
      });
      toast({ title: result.message, description: [result.label && !result.alreadySaved ? `Labelled "${result.label}".` : null, result.note].filter(Boolean).join(" ") || undefined });
      setOptionsOpen(false);
      setLabel("");
    } catch (err) {
      toast({ title: "Couldn't save to the project", description: errorText(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || autoStatus?.state === "saving";
  const nextVersion = latest?.nextVersion ?? null;
  const savedLink = data.savedVersion && (state === "saved" || state === "changed-since-save") && (
    <Button size="sm" variant="link" className="h-7 px-1 text-xs" onClick={() => openSitePage(navigate, `/matters/${projectId ?? ""}`)} disabled={!projectId}>
      <FileText className="mr-1 h-3.5 w-3.5" />
      {state === "saved" ? `Saved as v${data.savedVersion}` : `v${data.savedVersion} saved earlier`} · open project
    </Button>
  );

  let line: React.ReactNode;
  if (autoStatus?.state === "saving" || autoStatus?.state === "scheduled") {
    line = (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving to the project…
      </span>
    );
  } else if (state === "saved") {
    line = savedLink;
  } else if (state === "unchanged") {
    line = <span className="text-xs text-muted-foreground">Opened from the project · no changes to save yet</span>;
  } else if (target) {
    line = (
      <>
        <span className="text-xs text-amber-800 dark:text-amber-300">{state === "changed-since-save" ? `Changed since v${data.savedVersion} was saved` : "Not saved to the project yet"} —</span>
        <Button size="sm" className="h-7" onClick={() => void save({ mode: "next-version" })} disabled={busy} data-testid="save-to-matter">
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
          {saveButtonLabel({ mode: "next-version", nextVersion, waiting, truncated: data.truncated })}
        </Button>
        {savedLink}
      </>
    );
  } else {
    line = (
      <>
        <span className="text-xs text-amber-800 dark:text-amber-300">{projectId ? "Not saved to the project yet —" : "Not saved to a project yet —"}</span>
        <Button size="sm" className="h-7" onClick={() => void save({ mode: "new-document" })} disabled={busy} data-testid="save-to-matter">
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
          {projectId ? saveButtonLabel({ mode: "new-document", waiting, truncated: data.truncated }) : "Save to a project…"}
        </Button>
        {savedLink}
      </>
    );
  }

  return (
    <div className="space-y-2 border-b bg-muted/30 px-3 py-2" data-testid="save-bar">
      <div className="flex flex-wrap items-center gap-2">
        {line}
        <div className="ml-auto flex items-center gap-2">
          {matterId && target && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="After each AI turn, its new copy is saved as the next version of the project document.">
              <Switch checked={autoSave} onCheckedChange={(on) => setAutoSave(head.thread_id, on)} aria-label="Save AI drafts automatically" data-testid="auto-save-switch" />
              Save AI drafts automatically
            </label>
          )}
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOptionsOpen((o) => !o)} aria-label="More ways to save" aria-expanded={optionsOpen} title="More ways to save">
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {autoStatus?.state === "failed" && <p className="text-xs text-destructive">Automatic save didn't work: {autoStatus.message}</p>}
      {optionsOpen && (
        <div className="flex flex-wrap items-center gap-2" data-testid="save-options">
          <Select value={mode} onValueChange={(v) => setMode(v as "next-version" | "new-document")}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="Save as">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="next-version" disabled={!target}>
                {nextVersion ? `Next version (v${nextVersion})` : "Next version"}
              </SelectItem>
              <SelectItem value="new-document">New document</SelectItem>
            </SelectContent>
          </Select>
          {mode === "new-document" && (
            <Select value={documentTypeId ?? "none"} onValueChange={(v) => setDocumentTypeId(v === "none" ? undefined : v)}>
              <SelectTrigger className="h-8 w-52 text-xs" data-testid="artifact-doc-type">
                <SelectValue placeholder="Document type (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No specific type</SelectItem>
                {typesByCategory.map(([category, types]) => (
                  <SelectGroup key={category}>
                    <SelectLabel>{category}</SelectLabel>
                    {types.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Version label (optional)" className="h-8 w-56 text-xs" aria-label="Version label" maxLength={200} />
          <Button size="sm" className="h-8" onClick={() => void save({ mode, label })} disabled={busy || (mode === "next-version" && !target)}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
            {saveButtonLabel({ mode, nextVersion, waiting, truncated: data.truncated })}
          </Button>
        </div>
      )}
      <ProjectPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Save to which project?"
        description="The file will be added to that project's documents."
        onPick={(id) => {
          setPickerOpen(false);
          void save({ mode: "new-document", label, projectOverride: id });
        }}
      />
    </div>
  );
}
