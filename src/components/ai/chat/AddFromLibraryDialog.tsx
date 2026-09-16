import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { usePrecedentSources } from "@/hooks/usePrecedentLibrary";
import type { ChatAttachment } from "@/hooks/useChat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

interface AddFromLibraryDialogProps {
  documentTypeId: string;
  documentTypeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (attachment: ChatAttachment) => void;
}

// Attach a document from the Precedent Library as a source for a standard —
// this document type's precedents first, every type on request. The file
// itself is what the chat reads; the library's chunks are what retrieval
// searches.
export default function AddFromLibraryDialog({ documentTypeId, documentTypeName, open, onOpenChange, onPick }: AddFromLibraryDialogProps) {
  const { data: sources } = usePrecedentSources();
  const [query, setQuery] = useState("");
  const [allTypes, setAllTypes] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sources ?? []).filter(
      (s) => (allTypes || s.document_type_id === documentTypeId) && (!q || s.filename.toLowerCase().includes(q) || (s.document_type_name ?? "").toLowerCase().includes(q)),
    );
  }, [sources, query, allTypes, documentTypeId]);
  const ofType = (sources ?? []).filter((s) => s.document_type_id === documentTypeId).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from Precedent Library</DialogTitle>
          <DialogDescription>Use one of the firm's precedents as a source for the standard.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search precedents" className="pl-8" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={allTypes} onCheckedChange={(v) => setAllTypes(v === true)} />
          Show every document type, not only {documentTypeName} ({ofType})
        </label>
        <div className="max-h-80 overflow-y-auto rounded-md border">
          {rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {sources?.length ? (allTypes ? "No precedents match." : `No ${documentTypeName} precedents in the library yet — tick the box to look across every type, or upload one from the Precedents tab.`) : "The precedent library is empty."}
            </p>
          )}
          {rows.map((s) => (
            <button
              key={s.storage_path}
              type="button"
              data-testid="library-doc-option"
              className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent"
              onClick={() => {
                onPick({ bucket: "precedent-library", path: s.storage_path, name: s.filename });
                onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{s.filename}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {s.document_type_name ?? "Untyped"} · added {new Date(s.created_at).toLocaleDateString()}
                </div>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">Precedent</Badge>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
