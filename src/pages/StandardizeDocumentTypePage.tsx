import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Download, FileText, Gavel, History, Mail, Sparkles, Trash2, Upload } from "lucide-react";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import {
  useDocumentTypeTemplate,
  useUploadDocumentTypeTemplate,
  useDeleteDocumentTypeTemplate,
  useDocumentTemplateVersions,
  useRestoreDocumentTemplateVersion,
  fetchTemplateDocxBytes,
} from "@/hooks/useDocumentTypeTemplates";
import { useMyProfile, useProfiles } from "@/hooks/useProfiles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

// A change to the standard changes every later draft of the type, so each one
// is confirmed in a dialog that names the file being replaced.
interface PendingChange {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function StandardizeDocumentTypePage() {
  const { documentTypeId } = useParams<{ documentTypeId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: documentTypes } = useDocumentTypes();
  const { data: existingTemplate, isLoading } = useDocumentTypeTemplate(documentTypeId);
  const uploadTemplate = useUploadDocumentTypeTemplate();
  const deleteTemplate = useDeleteDocumentTypeTemplate();
  const { data: versions } = useDocumentTemplateVersions(documentTypeId);
  const restoreVersion = useRestoreDocumentTemplateVersion();
  const earlierVersions = (versions ?? []).filter((v) => v.storage_path !== existingTemplate?.storage_path);

  // Only administrators set the standard (the database enforces the same rule).
  const { data: me } = useMyProfile();
  const isAdmin = me?.role === "admin" || me?.role === "founder";
  const { data: profiles } = useProfiles();
  const adminEmails = (profiles ?? []).filter((p) => p.role === "admin" || p.role === "founder").map((p) => p.email);

  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const documentType = useMemo(
    () => documentTypes?.find((t) => t.id === documentTypeId),
    [documentTypes, documentTypeId]
  );
  const typeName = documentType?.name ?? "this document type";
  const currentFile = existingTemplate?.filename ?? null;

  const requestHref = adminEmails.length
    ? `mailto:${adminEmails.join(",")}?subject=${encodeURIComponent(`Firm standard for ${typeName}`)}&body=${encodeURIComponent(
        `Please ${currentFile ? `review the firm's standard for ${typeName} (currently "${currentFile}")` : `set a firm standard for ${typeName}`}.\n\n${window.location.href}`
      )}`
    : null;

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !documentTypeId) return;
    setPending({
      title: currentFile ? `Replace the standard for ${typeName}?` : `Set the standard for ${typeName}?`,
      description: currentFile
        ? `"${file.name}" will replace the current standard, "${currentFile}". Every draft of this type from now on will start from the new file. "${currentFile}" is kept under Earlier versions and can be restored.`
        : `"${file.name}" will become the firm's standard. Every draft of this type from now on will start from it.`,
      confirmLabel: currentFile ? "Replace the standard" : "Set as the standard",
      run: async () => {
        setUploading(true);
        try {
          await uploadTemplate.mutateAsync({ documentTypeId, file });
          toast({ title: "Standard updated", description: file.name });
        } catch (err) {
          toast({ title: "Couldn't set the standard", description: errorMessage(err), variant: "destructive" });
        } finally {
          setUploading(false);
        }
      },
    });
  };

  const handleDelete = () => {
    if (!documentTypeId || !currentFile) return;
    setPending({
      title: `Remove the standard for ${typeName}?`,
      description: `"${currentFile}" will no longer be the firm's standard, and drafts of this type will start from the firm's other precedent instead. The file is kept under Earlier versions and can be restored.`,
      confirmLabel: "Remove the standard",
      run: async () => {
        try {
          await deleteTemplate.mutateAsync({ documentTypeId, storagePath: existingTemplate?.storage_path ?? null });
          toast({ title: "Standard removed" });
        } catch (err) {
          toast({ title: "Couldn't remove the standard", description: errorMessage(err), variant: "destructive" });
        }
      },
    });
  };

  const handleRestore = (v: { id: string; filename: string | null }) => {
    if (!documentTypeId) return;
    const name = v.filename ?? "this version";
    setPending({
      title: `Restore an earlier standard for ${typeName}?`,
      description: currentFile
        ? `"${name}" will replace the current standard, "${currentFile}". "${currentFile}" stays under Earlier versions.`
        : `"${name}" will become the firm's standard again.`,
      confirmLabel: "Restore",
      run: async () => {
        try {
          await restoreVersion.mutateAsync({ documentTypeId, versionId: v.id });
          toast({ title: "Standard restored", description: name });
        } catch (err) {
          toast({ title: "Couldn't restore", description: errorMessage(err), variant: "destructive" });
        }
      },
    });
  };

  const confirmPending = async () => {
    if (!pending) return;
    setConfirming(true);
    try {
      await pending.run();
    } finally {
      setConfirming(false);
      setPending(null);
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
    } catch (err) {
      toast({ title: "Download failed", description: errorMessage(err), variant: "destructive" });
    }
  };

  if (!documentTypeId) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Gavel className="h-5 w-5 text-primary" />
          Standardise: {documentType?.name ?? "Document Type"}
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
              {isAdmin && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Remove the standard"
                  aria-label="Remove the standard"
                  onClick={handleDelete}
                  disabled={deleteTemplate.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
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

          {!isAdmin && me && (
            <div className="rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground" data-testid="standard-admin-only">
              <p>
                An administrator sets the firm's standard for each document type. You can build or revise one with
                AI below, then ask an administrator to set it.
              </p>
              {requestHref && (
                <a href={requestHref} className="mt-1.5 inline-flex items-center gap-1.5 font-medium text-foreground underline underline-offset-2">
                  <Mail className="h-3.5 w-3.5" />
                  Ask an administrator
                </a>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                data-testid="upload-standard"
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploading ? "Uploading…" : existingTemplate?.filename ? "Replace with a new .docx" : "Upload .docx"}
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate(`/precedent-library/standardize/${documentTypeId}/build`)} data-testid="build-standard-with-ai">
              <Sparkles className="h-4 w-4 mr-2" />
              {existingTemplate?.filename ? "Revise with AI" : "Build with AI"}
            </Button>
          </div>

          {earlierVersions.length > 0 && (
            <div className="rounded-md border" data-testid="standard-versions">
              <p className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
                <History className="h-3.5 w-3.5" /> Earlier versions
              </p>
              {earlierVersions.map((v) => (
                <div key={v.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{v.filename ?? v.storage_path.split("/").pop()}</p>
                    <p className="text-xs text-muted-foreground">{new Date(v.created_at).toLocaleString()}</p>
                  </div>
                  {isAdmin && (
                    <Button size="sm" variant="ghost" disabled={restoreVersion.isPending} onClick={() => handleRestore(v)}>
                      Restore
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {existingTemplate?.filename && (
            <Button variant="ghost" onClick={() => navigate("/precedent-library")}>
              Done
            </Button>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && !confirming && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirming}
              onClick={(e) => {
                e.preventDefault();
                void confirmPending();
              }}
              data-testid="confirm-standard-change"
            >
              {confirming ? "Working…" : pending?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
