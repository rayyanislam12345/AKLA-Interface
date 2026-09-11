import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { renderAsync } from "docx-preview";
import { acceptTrackedChanges } from "@/lib/docxAccept";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Download, FileText, Loader2, Save } from "lucide-react";
import { type ChatArtifact, useUpdateArtifact } from "@/hooks/useChat";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { useChatFile } from "@/hooks/useDocumentTypeTemplates";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface DocxArtifactData {
  bucket: string;
  storagePath: string;
  fileName: string;
  editSource?: { matterDocumentId?: string; documentVersionId?: string; versionNumber?: number; title: string; standard?: boolean } | null;
  documentTypeId?: string | null;
  standard?: boolean;
  original?: boolean;
  validation?: { placeholders?: Array<{ part: string; paragraph: number; text: string }>; format?: { status: string; findings: Array<{ detail: string; part: string }>; limitation: string } };
  changes?: Array<{ op: string; paragraph: number; status: string; summary: string; reason?: string }>;
  applied?: number;
  skipped?: number;
  savedMatterDocumentId?: string;
  savedVersion?: number;
  savedVersionId?: string;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// A Word file the chat is working on: the version as uploaded, the firm's
// standard, or the AI's latest copy with its changes shown as Word tracked
// changes. Nothing here is rebuilt from text — the preview is the file, the
// download is the file, and saving to the project stores the file.
export default function DocxArtifact({ matterId, artifact }: { matterId: string; artifact: ChatArtifact }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const data = (artifact.data ?? {}) as unknown as DocxArtifactData;
  const { data: blob, isLoading, error } = useChatFile(data.bucket, data.storagePath);
  const { data: documentTypes } = useDocumentTypes();
  const updateArtifact = useUpdateArtifact(artifact.thread_id);
  const previewRef = useRef<HTMLDivElement>(null);
  const [documentTypeId, setDocumentTypeId] = useState<string | undefined>(data.documentTypeId ?? undefined);
  const [form, setForm] = useState<"tracked" | "clean">("tracked");
  const [saving, setSaving] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);

  const documentTypeName = documentTypes?.find((t) => t.id === documentTypeId)?.name ?? "Document";
  const typesByCategory = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof documentTypes>>();
    for (const t of documentTypes ?? []) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
    return Array.from(groups.entries());
  }, [documentTypes]);

  useEffect(() => {
    if (!blob || !previewRef.current) return;
    previewRef.current.innerHTML = "";
    let cancelled = false;
    const render = async () => { const file = form === "clean" ? await acceptTrackedChanges(blob) : blob; if (!cancelled && previewRef.current) await renderAsync(file, previewRef.current, previewRef.current, { renderChanges: form !== "clean", inWrapper: true }); };
    render().catch((err) => {
      toast({ title: "Couldn't render the Word file", description: String(err?.message ?? err), variant: "destructive" });
    });
    return () => { cancelled = true; };
  }, [blob, form, toast]);

  const fileFor = async (): Promise<Blob> => {
    if (!blob) throw new Error("The file hasn't loaded yet");
    return form === "clean" ? acceptTrackedChanges(blob) : blob;
  };
  const baseName = data.fileName.replace(/\.docx$/i, "");

  const handleDownload = async () => {
    try {
      download(await fileFor(), `${baseName}${form === "clean" ? " (clean)" : data.original ? "" : " (tracked changes)"}.docx`);
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    }
  };

  const handleSave = async () => {
    if (!documentTypeId) {
      toast({ title: "Pick a document type first", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const file = await fileFor();
      const src = data.editSource;
      const result = await saveDraftToMatter({
        matterId,
        documentTypeId,
        documentTypeName,
        blob: file,
        title: src?.standard ? undefined : src?.title ?? baseName,
        matterDocumentId: data.savedMatterDocumentId ?? src?.matterDocumentId,
        expectedVersionId: data.savedVersionId ?? src?.documentVersionId,
      });
      await updateArtifact.mutateAsync({
        id: artifact.id,
        data: { ...(artifact.data as object), documentTypeId, savedMatterDocumentId: result.matterDocumentId, savedVersion: result.versionNumber, savedVersionId: result.versionId },
      });
      toast({ title: `Saved to the project as v${result.versionNumber}`, description: result.indexed ? result.fileName : `${result.fileName} — saved, but search indexing failed. Reprocess this document before relying on it in Ask AI.` });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const changes = data.changes ?? [];
  const skipped = changes.filter((c) => c.status !== "applied");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-xs text-muted-foreground" data-testid="docx-artifact-note">
          {data.original ? "As uploaded" : data.standard ? "Filled in from the firm's standard" : `${data.applied ?? 0} tracked change${data.applied === 1 ? "" : "s"}`}
          {" · "}
          {data.fileName}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!data.original && (
            <Select value={form} onValueChange={(v) => setForm(v as "tracked" | "clean")}>
              <SelectTrigger className="h-8 w-44 text-xs" data-testid="docx-form">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tracked">With tracked changes</SelectItem>
                <SelectItem value="clean">Clean (changes accepted)</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant="ghost" className="h-8" onClick={handleDownload} aria-label="Download .docx" disabled={!blob}>
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {!data.original && (
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
          <Button size="sm" className="h-8" onClick={handleSave} disabled={saving || !documentTypeId || !blob} data-testid="save-to-matter">
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {data.editSource?.matterDocumentId ? "Save as new version" : "Save to project"}
          </Button>
          {data.savedMatterDocumentId && (
            <Button size="sm" variant="link" className="h-8 px-1 text-xs" onClick={() => navigate(`/matters/${matterId}`)}>
              <FileText className="mr-1 h-3.5 w-3.5" />
              Saved as v{data.savedVersion} · open project
            </Button>
          )}
        </div>
      )}

      {data.validation && (
        <div className="border-b p-3 text-xs space-y-1" data-testid="docx-validation">
          <p className="font-medium">Document checks: {data.validation.format?.status === "checked" ? "source formatting preserved in checked properties" : "formatting needs review"}</p>
          <p>{data.validation.placeholders?.length ?? 0} unresolved placeholder occurrence(s).</p>
          {data.validation.placeholders?.slice(0, 12).map((p, i) => <p key={i}>{p.part}, paragraph {p.paragraph}: {p.text}</p>)}
          {data.validation.format?.findings.map((f, i) => <p key={i}>{f.part}: {f.detail}</p>)}
          <p className="text-muted-foreground">{data.validation.format?.limitation}</p>
        </div>
      )}
      {changes.length > 0 && (
        <div className="border-b px-3 py-2 text-xs">
          <button type="button" className="flex items-center gap-1 font-medium" onClick={() => setChangesOpen((o) => !o)}>
            {changesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {changes.length - skipped.length} change{changes.length - skipped.length === 1 ? "" : "s"} made
            {skipped.length > 0 && <span className="text-amber-700 dark:text-amber-400"> · {skipped.length} not applied</span>}
          </button>
          {changesOpen && (
            <ul className="mt-1.5 space-y-1" data-testid="docx-changes">
              {changes.map((c, i) => (
                <li key={i} className={cn("flex items-start gap-1.5", c.status !== "applied" && "text-muted-foreground")}>
                  {c.status === "applied" ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                  )}
                  <span>
                    {c.summary}
                    {c.reason && <span className="italic"> — {c.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading the Word file…</p>}
        {error && <p className="p-4 text-sm text-destructive">{String((error as Error).message)}</p>}
        <div ref={previewRef} className="docx-preview-container overflow-x-auto bg-muted/40 p-4" data-testid="docx-preview" />
      </div>
    </div>
  );
}
