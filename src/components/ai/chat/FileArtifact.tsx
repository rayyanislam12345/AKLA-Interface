import { Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatFile } from "@/hooks/useDocumentTypeTemplates";
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
// spreadsheet. There is nothing to edit in place, so it is offered as it is.
export default function FileArtifact({ artifact }: { artifact: ChatArtifact }) {
  const data = artifact.data as unknown as FileData;
  const { data: blob, isLoading, error } = useChatFile(data.bucket, data.storagePath);

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
        <Button size="sm" variant="outline" onClick={download} disabled={!blob}>
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          Download
        </Button>
      </div>
    </div>
  );
}
