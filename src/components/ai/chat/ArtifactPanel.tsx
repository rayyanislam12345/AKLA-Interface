import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { marked } from "marked";
import { renderAsync } from "docx-preview";
import type { Editor } from "@tiptap/react";
import { AlertTriangle, Check, Copy, Download, FileText, Loader2, Save, X } from "lucide-react";
import RichTextEditor from "@/components/editor/RichTextEditor";
import ReviewSession from "@/components/ai/ReviewSession";
import DocxArtifact from "@/components/ai/chat/DocxArtifact";
import { type ChatArtifact, useUpdateArtifact } from "@/hooks/useChat";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { fetchTemplateDocxBytes, useDocumentTypeTemplate } from "@/hooks/useDocumentTypeTemplates";
import type { LawUpdate } from "@/hooks/useLawUpdates";
import { buildFirmDocxBlob, type PMNode } from "@/lib/firmDocx";
import { buildTemplateDocxBlob } from "@/lib/templateDocx";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { artifactIcon } from "@/components/ai/chat/MarkdownMessage";

interface ArtifactPanelProps {
  matterId: string;
  matterName?: string;
  artifact: ChatArtifact;
  lawUpdate?: LawUpdate | null;
  onClose: () => void;
}

// The right-hand pane — claude.ai's artifact view. A draft or memo opens in
// an editable rich-text editor with a Word preview, copy, download and
// "Save to project"; a review opens the full three-pass ReviewSession for the
// document under review.
export default function ArtifactPanel({ matterId, matterName, artifact, lawUpdate, onClose }: ArtifactPanelProps) {
  const Icon = artifactIcon(artifact.kind);
  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="artifact-panel">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-sm" title={artifact.title}>
          <span className="font-medium">{artifact.title}</span>
          {(artifact.data as any)?.editSource && (
            <span className="ml-2 text-xs text-muted-foreground">
              {(artifact.data as any).original ? "as uploaded" : "edited"} · v{(artifact.data as any).editSource.versionNumber} of{" "}
              {(artifact.data as any).editSource.title}
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="Close panel">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {artifact.kind === "review" ? (
          <ReviewArtifact matterId={matterId} artifact={artifact} lawUpdate={lawUpdate ?? null} />
        ) : artifact.kind === "docx" ? (
          <DocxArtifact key={artifact.id} matterId={matterId} artifact={artifact} />
        ) : (
          <DocumentArtifact key={artifact.id} matterId={matterId} matterName={matterName} artifact={artifact} />
        )}
      </div>
    </div>
  );
}

function ReviewArtifact({ matterId, artifact, lawUpdate }: { matterId: string; artifact: ChatArtifact; lawUpdate: LawUpdate | null }) {
  const matterDocumentId = (artifact.data as any)?.matterDocumentId as string | undefined;
  if (!matterDocumentId) {
    return <p className="p-4 text-sm text-muted-foreground">This review isn't tied to a project document, so there's nothing to open here.</p>;
  }
  return (
    <div className="p-4">
      <ReviewSession key={artifact.id} matterId={matterId} matterDocumentId={matterDocumentId} documentVersionId={(artifact.data as any)?.documentVersionId} reviewRunId={(artifact.data as any)?.reviewRunId} lawUpdate={lawUpdate} />
    </div>
  );
}

function DocumentArtifact({ matterId, matterName, artifact }: { matterId: string; matterName?: string; artifact: ChatArtifact }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { data: documentTypes } = useDocumentTypes();
  const updateArtifact = useUpdateArtifact(artifact.thread_id);

  const editorRef = useRef<Editor | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);

  const initialDocTypeId = (artifact.data as any)?.documentTypeId as string | undefined;
  // An edit is saved back onto the document it came from, as its next version.
  const editSource = (artifact.data as any)?.editSource as
    | { matterDocumentId: string; versionNumber: number; title: string }
    | undefined;
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
    if (standard?.storage_path) {
      try {
        if (standardBytes.current?.path !== standard.storage_path) {
          standardBytes.current = { path: standard.storage_path, bytes: await fetchTemplateDocxBytes(standard.storage_path) };
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

  const handleSaveToMatter = async () => {
    if (!documentTypeId) {
      toast({ title: "Pick a document type first", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const blob = await buildBlob();
      if (!blob) throw new Error("Editor is not ready yet");
      const result = await saveDraftToMatter({
        matterId,
        documentTypeId,
        documentTypeName,
        blob,
        title: editSource ? editSource.title : artifact.kind === "draft" ? undefined : artifact.title,
        matterDocumentId: editSource?.matterDocumentId,
      });
      await updateArtifact.mutateAsync({
        id: artifact.id,
        data: { ...(artifact.data as object), documentTypeId, savedMatterDocumentId: result.matterDocumentId, savedVersion: result.versionNumber },
      });
      toast({
        title: `Saved to the project as v${result.versionNumber}`,
        description: result.fileName,
      });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saved = (artifact.data as any)?.savedMatterDocumentId as string | undefined;
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
        <Select value={documentTypeId} onValueChange={setDocumentTypeId}>
          <SelectTrigger className="h-8 w-56 text-xs" data-testid="artifact-doc-type">
            <SelectValue placeholder="Document type (for saving)" />
          </SelectTrigger>
          <SelectContent>
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
        <Button size="sm" className="h-8" onClick={handleSaveToMatter} disabled={saving || !documentTypeId} data-testid="save-to-matter">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {editSource ? "Save as new version" : "Save to project"}
        </Button>
        {standard?.filename && (
          <span className="text-xs text-muted-foreground" title={standard.filename} data-testid="standard-format-note">
            Uses firm standard · layout not verified
          </span>
        )}
        {saved && (
          <Button size="sm" variant="link" className="h-8 px-1 text-xs" onClick={() => navigate(`/matters/${matterId}`)}>
            <FileText className="mr-1 h-3.5 w-3.5" />
            Saved as v{(artifact.data as any)?.savedVersion} · open matter
          </Button>
        )}
      </div>

      {truncated && (
        <div className="flex items-start gap-2 border-b border-amber-400/60 bg-amber-50 px-3 py-2 text-xs dark:border-amber-700/50 dark:bg-amber-950/20">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <span>
            This document stops before the end — it ran past the model's limit. Ask in the chat to carry on from the
            last clause before saving it to the project.
          </span>
        </div>
      )}

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
