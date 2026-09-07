import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import type { ChatAttachment } from "@/hooks/useChat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface AddFromMatterDialogProps {
  matterId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (attachment: ChatAttachment) => void;
}

// Attach one of the matter's own documents (its latest version) to the
// conversation. Carries the version id so Verify knows what to review.
export default function AddFromMatterDialog({ matterId, open, onOpenChange, onPick }: AddFromMatterDialogProps) {
  const { data: documents } = useMatterDocuments(matterId);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (documents ?? [])
      .map((d) => ({ doc: d, latest: d.versions?.[0] }))
      .filter(({ doc, latest }) => latest && (!q || doc.title.toLowerCase().includes(q) || latest.file_name.toLowerCase().includes(q)));
  }, [documents, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from project</DialogTitle>
          <DialogDescription>Attach the latest version of a document already on this project.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents" className="pl-8" />
        </div>
        <div className="max-h-80 overflow-y-auto rounded-md border">
          {rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {documents?.length ? "No documents match." : "No documents with an uploaded version on this project yet."}
            </p>
          )}
          {rows.map(({ doc, latest }) => (
            <button
              key={doc.id}
              type="button"
              data-testid="matter-doc-option"
              className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent"
              onClick={() => {
                onPick({
                  bucket: "matter-documents",
                  path: latest!.storage_path,
                  name: latest!.file_name,
                  matterDocumentId: doc.id,
                  versionId: latest!.id,
                });
                onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{doc.title}</div>
                <div className="truncate text-xs text-muted-foreground">{latest!.file_name}</div>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">v{latest!.version_number}</Badge>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
