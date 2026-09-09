import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import type { EditTarget } from "@/hooks/useChat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface EditDocumentDialogProps {
  matterId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (target: EditTarget) => void;
}

// Pick the exact version to edit: every document on the project, each with
// all of its versions listed newest first. Unlike Add from project this is
// version-precise on purpose — an associate editing v2 while v3 exists is a
// deliberate choice, not a mistake to paper over.
export default function EditDocumentDialog({ matterId, open, onOpenChange, onPick }: EditDocumentDialogProps) {
  const { data: documents } = useMatterDocuments(matterId);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (documents ?? [])
      .filter((d) => (d.versions?.length ?? 0) > 0)
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.versions.some((v) => v.file_name.toLowerCase().includes(q)))
      .map((d) => ({ doc: d, versions: [...d.versions].sort((a, b) => b.version_number - a.version_number) }));
  }, [documents, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit a document</DialogTitle>
          <DialogDescription>
            Choose the version to work from. It opens in the panel on the right; describe the changes in the chat and
            the edited document appears beside it.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents" className="pl-8" />
        </div>
        <div className="max-h-96 overflow-y-auto rounded-md border">
          {rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {documents?.length ? "No documents match." : "No documents with an uploaded version on this project yet."}
            </p>
          )}
          {rows.map(({ doc, versions }) => (
            <div key={doc.id} className="border-b last:border-b-0">
              <div className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{doc.title}</span>
                {(doc as any).document_type?.name && (
                  <span className="shrink-0 text-xs text-muted-foreground">{(doc as any).document_type.name}</span>
                )}
              </div>
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  data-testid="edit-version-option"
                  className="flex w-full items-center gap-3 px-3 py-2 pl-9 text-left hover:bg-accent"
                  onClick={() => {
                    onPick({
                      matterDocumentId: doc.id,
                      documentTypeId: doc.document_type_id ?? null,
                      title: doc.title,
                      versionId: v.id,
                      versionNumber: v.version_number,
                      fileName: v.file_name,
                      storagePath: v.storage_path,
                    });
                    onOpenChange(false);
                  }}
                >
                  <Badge variant="outline" className="shrink-0 text-[10px]">v{v.version_number}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{v.file_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(v.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
