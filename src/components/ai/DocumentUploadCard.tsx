import { useMemo, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { useCreateMatterDocument, useDocumentTypes, useUploadDocumentVersion } from "@/hooks/useMatterDocuments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export const UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.xls,.pptx";

interface DocumentUploadCardProps {
  matterId: string;
  onUploaded?: (matterDocumentId: string) => void;
  hint?: string;
}

// Add a document to the matter without leaving the AI Workspace: pick a file,
// classify it with a document type, and it goes through exactly the same
// pipeline as the Documents card on the matter page — a matter_documents row,
// a v1 document_versions row, then process-document for text extraction +
// embedding. That last step is awaited inside useUploadDocumentVersion (it can
// take a while for scanned PDFs), so onUploaded only fires once the document
// is actually searchable — that's the moment Ask can see it and Verify can
// review it.
export default function DocumentUploadCard({ matterId, onUploaded, hint }: DocumentUploadCardProps) {
  const { data: documentTypes } = useDocumentTypes();
  const createDocument = useCreateMatterDocument();
  const uploadVersion = useUploadDocumentVersion();
  const { toast } = useToast();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [documentTypeId, setDocumentTypeId] = useState("");

  const busy = createDocument.isPending || uploadVersion.isPending;

  const typesByCategory = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof documentTypes>>();
    for (const type of documentTypes ?? []) {
      const list = groups.get(type.category) ?? [];
      list.push(type);
      groups.set(type.category, list);
    }
    return Array.from(groups.entries());
  }, [documentTypes]);

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0] ?? null;
    e.target.value = "";
    setFile(chosen);
    if (chosen && !title.trim()) {
      setTitle(chosen.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleUpload = async () => {
    if (!file || !documentTypeId || !title.trim()) return;
    try {
      const created = await createDocument.mutateAsync({
        matter_id: matterId,
        title: title.trim(),
        document_type_id: documentTypeId,
      });
      await uploadVersion.mutateAsync({
        matterId,
        matterDocumentId: created.id,
        documentTypeId,
        file,
        nextVersionNumber: 1,
      });
      toast({ title: "Document uploaded and indexed" });
      setFile(null);
      setTitle("");
      setDocumentTypeId("");
      onUploaded?.(created.id);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <input ref={fileInputRef} type="file" accept={UPLOAD_ACCEPT} className="hidden" onChange={handleFileChosen} />

      <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="justify-start sm:w-40"
        >
          <Upload className="h-4 w-4 mr-2" />
          {file ? "Change file" : "Choose file"}
        </Button>
        <p className="text-sm text-muted-foreground self-center truncate">
          {file ? file.name : "PDF, Word, Excel, or PowerPoint"}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Title</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" disabled={busy} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Document type</label>
          <Select value={documentTypeId} onValueChange={setDocumentTypeId} disabled={busy}>
            <SelectTrigger>
              <SelectValue placeholder="Select a document type" />
            </SelectTrigger>
            <SelectContent>
              {typesByCategory.map(([category, types]) => (
                <SelectGroup key={category}>
                  <SelectLabel>{category}</SelectLabel>
                  {types.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button onClick={handleUpload} disabled={!file || !documentTypeId || !title.trim() || busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Uploading &amp; indexing…
          </>
        ) : (
          <>
            <Upload className="h-4 w-4 mr-2" />
            Upload to matter
          </>
        )}
      </Button>
    </div>
  );
}
