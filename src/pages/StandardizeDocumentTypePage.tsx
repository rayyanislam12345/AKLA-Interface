import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Download, FileText, Gavel, Trash2, Upload } from "lucide-react";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import {
  useDocumentTypeTemplate,
  useUploadDocumentTypeTemplate,
  useDeleteDocumentTypeTemplate,
  fetchTemplateDocxBytes,
} from "@/hooks/useDocumentTypeTemplates";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

export default function StandardizeDocumentTypePage() {
  const { documentTypeId } = useParams<{ documentTypeId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: documentTypes } = useDocumentTypes();
  const { data: existingTemplate, isLoading } = useDocumentTypeTemplate(documentTypeId);
  const uploadTemplate = useUploadDocumentTypeTemplate();
  const deleteTemplate = useDeleteDocumentTypeTemplate();

  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const documentType = useMemo(
    () => documentTypes?.find((t) => t.id === documentTypeId),
    [documentTypes, documentTypeId]
  );

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !documentTypeId) return;
    setUploading(true);
    try {
      await uploadTemplate.mutateAsync({ documentTypeId, file });
      toast({ title: "Standard version uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!documentTypeId) return;
    if (!window.confirm(`Remove the standard version for "${documentType?.name ?? "this document type"}"?`)) return;
    try {
      await deleteTemplate.mutateAsync({ documentTypeId, storagePath: existingTemplate?.storage_path ?? null });
      toast({ title: "Standard version removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  const handleDownload = async () => {
    if (!existingTemplate?.storage_path) return;
    try {
      const bytes = await fetchTemplateDocxBytes(existingTemplate.storage_path);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = existingTemplate.filename ?? "standard.docx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    }
  };

  if (!documentTypeId) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Gavel className="h-5 w-5 text-primary" />
          Standardize: {documentType?.name ?? "Document Type"}
        </h1>
        <p className="text-muted-foreground">
          The firm's canonical .docx for this document type. Drafting follows its clause structure ahead of the
          firm's other precedent, and every draft of this type is exported inside this file — its page setup,
          headers and footers, fonts and clause numbering are kept, and only the text changes.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={handleFileSelected}
          />

          {isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : existingTemplate?.filename ? (
            <div className="flex items-center gap-3 border rounded-md px-3 py-2.5">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{existingTemplate.filename}</p>
                <p className="text-xs text-muted-foreground">
                  Updated {existingTemplate.updated_at ? new Date(existingTemplate.updated_at).toLocaleDateString() : ""}
                </p>
              </div>
              <Button size="icon" variant="ghost" title="Download the standard" onClick={handleDownload}>
                <Download className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Remove standard version"
                onClick={handleDelete}
                disabled={deleteTemplate.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No standard version uploaded yet.</p>
          )}

          {existingTemplate?.format_rules && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="standard-format-rules">
              <p className="mb-1 font-medium text-foreground">How this file is formatted</p>
              <p>{existingTemplate.format_rules}</p>
              <p className="mt-1">
                Drafts pick this up automatically: clause headings take the file's numbering, body text its font and
                spacing, and the page keeps its headers and footers.
              </p>
            </div>
          )}

          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="h-4 w-4 mr-2" />
            {uploading ? "Uploading…" : existingTemplate?.filename ? "Replace with a new .docx" : "Upload .docx"}
          </Button>

          {existingTemplate?.filename && (
            <Button variant="ghost" onClick={() => navigate("/precedent-library")}>
              Done
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
