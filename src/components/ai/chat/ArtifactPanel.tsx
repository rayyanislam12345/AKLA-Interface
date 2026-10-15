import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { marked } from "marked";
import { renderAsync } from "docx-preview";
import type { Editor } from "@tiptap/react";
import { AlertTriangle, Check, Copy, Download, FileText, Loader2, Save, X } from "lucide-react";
import RichTextEditor from "@/components/editor/RichTextEditor";
import ReviewSession from "@/components/ai/ReviewSession";
import FileArtifact from "@/components/ai/chat/FileArtifact";
import DocxArtifact from "@/components/ai/chat/DocxArtifact";
import { type ChatArtifact, useUpdateArtifact } from "@/hooks/useChat";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { fetchTemplateDocxBytes, useDocumentTypeTemplate } from "@/hooks/useDocumentTypeTemplates";
import type { LawUpdate } from "@/hooks/useLawUpdates";
import { buildFirmDocxBlob, type PMNode } from "@/lib/firmDocx";
import { buildTemplateDocxBlob } from "@/lib/templateDocx";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { supabase } from "@/integrations/supabase/client";
import { fetchMatterDocumentTypeId } from "@/hooks/useRedline";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { artifactIcon } from "@/components/ai/chat/MarkdownMessage";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";

interface ArtifactPanelProps {
  matterId?: string;
  matterName?: string;
  // A standardisation session: the Word file can be set as the type's
  // standard, and there is no project to save it to.
  standard?: { documentTypeId: string; documentTypeName: string };
  artifact: ChatArtifact;
  lawUpdate?: LawUpdate | null;
  onClose: () => void;
}

// The right-hand pane — claude.ai's artifact view. A draft or memo opens in
// an editable rich-text editor with a Word preview, copy, download and
// "Save to project"; a review opens the full three-pass ReviewSession for the
// document under review.
export default function ArtifactPanel({ matterId, matterName, standard, artifact, lawUpdate, onClose }: ArtifactPanelProps) {
  const Icon = artifactIcon(artifact.kind);
  const incomplete = (artifact.data as { truncated?: boolean } | null)?.truncated === true;
  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="artifact-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-sm" title={artifact.title}>
          <span className="font-medium">{artifact.title}</span>
          {/* The working document names where it came from and where it stands:
              the project, the version it was opened from, and whether it has
              been saved back — the one line the workflow proposal asks for. */}
          {artifact.kind !== "review" && (() => {
            const d = (artifact.data ?? {}) as any;
            const es = d.editSource;
            const origin = es
              ? es.standard
                ? "from the firm's standard"
                : `${d.original ? "as uploaded" : "edited"} · ${es.versionNumber ? `v${es.versionNumber} of ${es.title}` : es.title}`
              : matterName ?? "not in a project";
            const saved = d.savedVersion ? `saved as v${d.savedVersion}` : matterId ? "not saved to the project yet" : "not saved yet";
            return <span className="ml-2 text-xs text-muted-foreground">{origin} · {saved}</span>;
          })()}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {incomplete && (
        <div role="status" className="flex items-start gap-2 border-b border-amber-400/60 bg-amber-50 px-3 py-2 text-xs dark:border-amber-700/50 dark:bg-amber-950/20" data-testid="incomplete-document-notice">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <span>
            <strong>Incomplete draft.</strong> Generation ended before this document was finished. Ask in the chat to complete it.
            This copy cannot be published as a standard.
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {artifact.kind === "review" ? (
          <ReviewArtifact matterId={matterId} artifact={artifact} lawUpdate={lawUpdate ?? null} />
        ) : artifact.kind === "docx" ? (
          <DocxArtifact key={artifact.id} matterId={matterId} standard={standard} artifact={artifact} />
        ) : artifact.kind === "file" ? (
          <FileArtifact key={artifact.id} artifact={artifact} matterId={matterId} />
        ) : (
          <DocumentArtifact key={artifact.id} matterId={matterId} matterName={matterName} standard={standard} artifact={artifact} />
        )}
      </div>
    </div>
  );
}

// A review belongs to the project the reviewed document is in. Started from
// the general assistant, there is no project open: the review carries its
// project (or, for one saved before it did, the document's project is
// looked up), so it opens here instead of as an empty editor.
function ReviewArtifact({ matterId: openMatterId, artifact, lawUpdate }: { matterId?: string; artifact: ChatArtifact; lawUpdate: LawUpdate | null }) {
  const matterDocumentId = (artifact.data as any)?.matterDocumentId as string | undefined;
  const knownMatterId = openMatterId ?? artifact.matter_id ?? undefined;
  const { data: lookedUp, isLoading } = useQuery({
    queryKey: ["matter-document-project", matterDocumentId],
    enabled: !knownMatterId && !!matterDocumentId,
    queryFn: async () => {
      const { data, error } = await supabase.from("matter_documents").select("matter_id").eq("id", matterDocumentId!).maybeSingle();
      if (error) throw error;
      return data?.matter_id ?? null;
    },
  });
  const matterId = knownMatterId ?? lookedUp ?? undefined;
  if (!matterDocumentId) {
    return <p className="p-4 text-sm text-muted-foreground">This review isn't tied to a project document, so there's nothing to open here.</p>;
  }
  if (!matterId) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {isLoading ? "Opening the review…" : "The document this review was run on is no longer in a project, so the review can't be opened."}
      </p>
    );
  }
  return (
    <div className="p-4">
      <ReviewSession key={artifact.id} matterId={matterId} matterDocumentId={matterDocumentId} documentVersionId={(artifact.data as any)?.documentVersionId} reviewRunId={(artifact.data as any)?.reviewRunId} lawUpdate={lawUpdate} />
    </div>
  );
}

function DocumentArtifact({ matterId, matterName, standard: session, artifact }: { matterId?: string; matterName?: string; standard?: { documentTypeId: string; documentTypeName: string }; artifact: ChatArtifact }) {
  // Saving from a general chat (no project open) asks which project first.
  const [pickerOpen, setPickerOpen] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: documentTypes } = useDocumentTypes();
  const updateArtifact = useUpdateArtifact(artifact.thread_id);

  const editorRef = useRef<Editor | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<{ matterDocumentId: string; versionId: string; versionNumber: number; documentTypeId?: string; matterId?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);

  const initialDocTypeId = (artifact.data as any)?.documentTypeId as string | undefined;
  // An edit is saved back onto the document it came from, as its next version.
  const editSource = (artifact.data as any)?.editSource as
    | { matterDocumentId: string; documentVersionId?: string; versionNumber: number; title: string }
    | undefined;
  const [saveMode, setSaveMode] = useState<"new" | "version">((artifact.data as any)?.savedMatterDocumentId || editSource?.matterDocumentId ? "version" : "new");
  const [documentTypeId, setDocumentTypeId] = useState<string | undefined>(initialDocTypeId);
  const documentTypeName = documentTypes?.find((t) => t.id === documentTypeId)?.name ?? "Document";
  // The firm's standard .docx for this type, when there is one: the draft is
  // exported inside that file so its formatting and numbering are kept.
  const { data: standard } = useDocumentTypeTemplate(documentTypeId);
  const standardBytes = useRef<{ path: string; bytes: ArrayBuffer } | null>(null);

  const html = useMemo(() => (artifact.content ? (marked.parse(artifact.content, { async: false }) as string) : ""), [artifact.content]);

  const typesByCategory = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof documentTypes>>();
    for (const t of documentTypes ?? []) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
    return Array.from(groups.entries());
  }, [documentTypes]);

  const buildBlob = async (): Promise<Blob | null> => {
    const editor = editorRef.current;
    if (!editor) return null;
    const pinnedPath = (artifact.data as any)?.templatePath ?? standard?.storage_path;
    if (pinnedPath) {
      try {
        if (standardBytes.current?.path !== pinnedPath) {
          standardBytes.current = { path: pinnedPath, bytes: await fetchTemplateDocxBytes(pinnedPath) };
        }
        return await buildTemplateDocxBlob(standardBytes.current.bytes, editor.getJSON() as PMNode);
      } catch (err) {
        throw new Error(`The firm standard could not be applied. Export stopped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const header = `${matterName ?? ""} — ${artifact.kind === "draft" ? documentTypeName : artifact.title} — AKLA — Draft, For Internal Purposes Only — ${date}`;
    return buildFirmDocxBlob(editor.getJSON() as PMNode, header);
  };

  const renderPreview = async () => {
    setBuildingPreview(true);
    try {
      const blob = await buildBlob();
      if (blob && previewRef.current) {
        previewRef.current.innerHTML = "";
        await renderAsync(blob, previewRef.current, previewRef.current, { inWrapper: true });
      }
    } catch (err: any) {
      toast({ title: "Failed to build preview", description: err.message, variant: "destructive" });
    } finally {
      setBuildingPreview(false);
    }
  };

  useEffect(() => {
    if (tab === "preview") renderPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, artifact.content, standard?.storage_path]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(artifact.content ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = async () => {
    try {
    const blob = await buildBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/[^\w.-]+/g, "-")}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    } catch (err) { toast({ title: "Export failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" }); }
  };

  // Manual edits live in the editor until the lawyer saves them back; the
  // artifact row is what the chat keeps referring to, so keep it current.
  const handleSaveEdits = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    // Store the edited HTML — marked won't round-trip, and the docx builder
    // reads the editor, so the artifact's text only needs to reopen faithfully.
    await updateArtifact.mutateAsync({ id: artifact.id, content: editor.getHTML() });
    setDirty(false);
    toast({ title: "Edits saved" });
  };

  // A document type is optional: an untyped document has always been valid in
  // the database; only this button used to insist on one.
  const handleSaveToMatter = async (targetMatterId = matterId) => {
    if (!targetMatterId) {
      if (session) toast({ title: "This document belongs to a standardisation session, not a project", variant: "destructive" });
      else setPickerOpen(true);
      return;
    }
    setSaving(true);
    try {
      const blob = await buildBlob();
      if (!blob) throw new Error("Editor is not ready yet");
      const savedMatterDocumentId = (artifact.data as { savedMatterDocumentId?: string } | null)?.savedMatterDocumentId;
      const target = saveMode === "new" ? undefined : lastSave?.matterDocumentId ?? savedMatterDocumentId ?? editSource?.matterDocumentId;
      // A new version keeps the document's own type as stored now (none for
      // an untyped document); the database accepts no other.
      const typeId = target ? await fetchMatterDocumentTypeId(target) : documentTypeId ?? null;
      const result = await saveDraftToMatter({
        matterId: targetMatterId,
        documentTypeId: typeId,
        documentTypeName,
        blob,
        title: editSource ? editSource.title : artifact.kind === "draft" ? undefined : artifact.title,
        matterDocumentId: target,
        expectedVersionId: lastSave?.versionId ?? (artifact.data as any)?.savedVersionId ?? editSource?.documentVersionId,
      });
      setLastSave({ ...result, documentTypeId: typeId ?? undefined, matterId: targetMatterId });
      queryClient.invalidateQueries({ queryKey: ["matter-documents", targetMatterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
      await updateArtifact.mutateAsync({
        id: artifact.id,
        data: { ...(artifact.data as object), documentTypeId: typeId, savedMatterDocumentId: result.matterDocumentId, savedVersion: result.versionNumber, savedVersionId: result.versionId },
      }).catch(() => toast({ title: "File saved; chat link could not update", description: "Your version is available in the project Documents section." }));
      setSaveMode("version");
      toast({
        title: `Saved to the project as v${result.versionNumber}`,
        description: result.indexed ? result.fileName : `${result.fileName} — saved, but it couldn't be prepared for search. Open the project and press Try again.`,
      });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saved = lastSave?.matterDocumentId ?? (artifact.data as any)?.savedMatterDocumentId as string | undefined;
  // Set by the chat function when the model ran out of room even after being
  // continued — worth saying loudly, because saving a half-written agreement
  // to the project as a version is exactly the mistake this would cause.
  const truncated = !!(artifact.data as any)?.truncated;
  // Content is Markdown from the model or HTML after a manual save.
  const editorContent = artifact.content?.trimStart().startsWith("<") ? artifact.content : html;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "edit" | "preview")}>
          <TabsList className="h-8">
            <TabsTrigger value="edit" className="text-xs">Edit</TabsTrigger>
            <TabsTrigger value="preview" className="text-xs">Word preview</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1">
          {dirty && (
            <Button size="sm" variant="secondary" className="h-8" onClick={handleSaveEdits} disabled={updateArtifact.isPending}>
              Save edits
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8" onClick={handleCopy} aria-label="Copy">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={handleDownload} aria-label="Download .docx">
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Select value={documentTypeId ?? "none"} onValueChange={(v) => setDocumentTypeId(v === "none" ? undefined : v)} disabled={saveMode === "version" && !!(lastSave?.documentTypeId ?? initialDocTypeId)}>
          <SelectTrigger className="h-8 w-56 text-xs" data-testid="artifact-doc-type">
            <SelectValue placeholder="Document type (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No specific type</SelectItem>
            {typesByCategory.map(([category, types]) => (
              <SelectGroup key={category}>
                <SelectLabel>{category}</SelectLabel>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Select value={saveMode} onValueChange={v => { setSaveMode(v as "new" | "version"); if (v === "version") setDocumentTypeId(lastSave?.documentTypeId ?? initialDocTypeId ?? undefined); }}><SelectTrigger className="h-8 w-44 text-xs" aria-label="Save destination"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="new">New document</SelectItem><SelectItem value="version" disabled={!lastSave && !(artifact.data as any)?.savedMatterDocumentId && !editSource?.matterDocumentId}>New version</SelectItem></SelectContent></Select>
        <Button size="sm" className="h-8" onClick={() => handleSaveToMatter()} disabled={saving} data-testid="save-to-matter">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {truncated ? "Save incomplete draft" : saveMode === "version" ? "Save new version" : "Create document"}
        </Button>
        <ProjectPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} title="Save to which project?" description="The document will be added to that project's documents." onPick={(id) => { setPickerOpen(false); void handleSaveToMatter(id); }} />
        {standard?.filename && (
          <span className="text-xs text-muted-foreground" title={standard.filename} data-testid="standard-format-note">
            Uses firm standard · layout not verified
          </span>
        )}
        {saved && (
          <Button size="sm" variant="link" className="h-8 px-1 text-xs" onClick={() => navigate(`/matters/${lastSave?.matterId ?? matterId}`)}>
            <FileText className="mr-1 h-3.5 w-3.5" />
            Saved as v{lastSave?.versionNumber ?? (artifact.data as any)?.savedVersion} · open project
          </Button>
        )}
      </div>

      {/* Both stay mounted: the docx export reads the editor even while the preview tab is showing. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div hidden={tab !== "edit"}>
          <RichTextEditor
            ref={editorRef}
            content={editorContent}
            onChange={() => setDirty(true)}
            className="prose prose-sm max-w-none p-6 focus:outline-none [&_.ProseMirror]:min-h-[60vh] [&_.ProseMirror]:outline-none"
          />
        </div>
        <div hidden={tab !== "preview"}>
          {buildingPreview && <p className="p-4 text-sm text-muted-foreground">Building preview…</p>}
          <div ref={previewRef} className="docx-preview-container overflow-x-auto bg-muted/40 p-4" />
        </div>
      </div>
    </div>
  );
}
