import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, FolderKanban, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useChatFile } from "@/hooks/useDocumentTypeTemplates";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import type { ChatArtifact } from "@/hooks/useChat";

interface FileData {
  bucket: string;
  storagePath: string;
  fileName: string;
  size?: number;
  mime?: string | null;
  generatedBy?: string;
}

const readableSize = (bytes?: number) =>
  bytes == null ? "" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// A file a skill handed back that is not a Word document — a PDF, a
// spreadsheet, a slide deck. There is nothing to edit in place, so it is
// offered as it is: to download, or to save into a project as a document of
// its own, with a version like any Word draft. Saving needs a project; with
// none open (a general chat) it asks which one.
export default function FileArtifact({ artifact, matterId }: { artifact: ChatArtifact; matterId?: string }) {
  const data = artifact.data as unknown as FileData;
  const { data: blob, isLoading, error } = useChatFile(data.bucket, data.storagePath);
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saved, setSaved] = useState<{ matterId: string; versionNumber: number } | null>(null);

  const download = () => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const save = async (targetMatterId = matterId) => {
    if (!targetMatterId) { setPickerOpen(true); return; }
    if (!blob) return;
    setSaving(true);
    try {
      const dot = data.fileName.lastIndexOf(".");
      const extension = dot > 0 ? data.fileName.slice(dot + 1).toLowerCase() : "bin";
      const title = dot > 0 ? data.fileName.slice(0, dot) : data.fileName;
      const result = await saveDraftToMatter({ matterId: targetMatterId, documentTypeId: null, documentTypeName: "Document", blob, title, extension });
      setSaved({ matterId: targetMatterId, versionNumber: result.versionNumber });
      queryClient.invalidateQueries({ queryKey: ["matter-documents", targetMatterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
      toast({ title: `Saved to the project as v${result.versionNumber}`, description: result.indexed ? result.fileName : `${result.fileName} — saved; this file type isn't searchable by text.` });
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4">
      <div className="flex items-start gap-3 rounded-md border p-4">
        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">{data.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {[data.generatedBy ? `Produced by /${data.generatedBy}` : null, readableSize(data.size)].filter(Boolean).join(" · ")}
          </p>
          {error && <p className="mt-2 text-xs text-destructive">{(error as Error).message}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={download} disabled={!blob}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download
          </Button>
          {saved ? (
            <Button size="sm" variant="link" className="h-8 px-1 text-xs" onClick={() => navigate(`/matters/${saved.matterId}`)}>
              <FolderKanban className="mr-1 h-3.5 w-3.5" />
              Saved as v{saved.versionNumber} · open project
            </Button>
          ) : (
            <Button size="sm" onClick={() => save()} disabled={saving || !blob} data-testid="save-file-to-matter">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save to project
            </Button>
          )}
        </div>
      </div>
      <ProjectPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Save to which project?"
        description="The file will be added to that project's documents."
        onPick={(id) => { setPickerOpen(false); void save(id); }}
      />
    </div>
  );
}
