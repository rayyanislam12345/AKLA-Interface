import { useEffect, useRef, useState } from "react";
import { Globe, Loader2, Upload } from "lucide-react";
import { useFindLawOnline, useUploadLawToLibrary } from "@/hooks/useLawLibrary";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface AddLawDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // What the associate had typed when they asked to add a law.
  initialName?: string;
  // The Act's name as it now appears in the library.
  onAdded?: (actName: string) => void;
}

// Adding an Act to the law library from wherever the associate is — the
// Law Library tab, or a standardisation session that needs a law the
// library does not hold. Two routes: find it on official sources (the chat
// server searches pakistancode.gov.pk, then the web, downloads the PDF and
// checks it is the Act named), or upload the Act as a file.
export default function AddLawDialog({ open, onOpenChange, initialName = "", onAdded }: AddLawDialogProps) {
  const { toast } = useToast();
  const findLaw = useFindLawOnline();
  const uploadLaw = useUploadLawToLibrary();
  const [name, setName] = useState(initialName);
  const [notFound, setNotFound] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setName(initialName);
      setNotFound(null);
    }
  }, [open, initialName]);

  const busy = findLaw.isPending || uploadLaw.isPending;
  const trimmed = name.trim();

  const handleFind = async () => {
    if (!trimmed) return;
    setNotFound(null);
    try {
      const result = await findLaw.mutateAsync({ actName: trimmed });
      if (result.status === "available") {
        toast({
          title: result.alreadyInLibrary ? "Already in the law library" : "Added to the law library",
          description: result.actName + (result.sourceUrl ? ` — from ${new URL(result.sourceUrl).hostname}` : ""),
        });
        onAdded?.(result.actName);
        onOpenChange(false);
      } else {
        setNotFound(result.reason);
      }
    } catch (err: any) {
      toast({ title: "Couldn't find the law", description: err.message, variant: "destructive" });
    }
  };

  const handleUpload = async (file: File) => {
    if (!trimmed) {
      toast({ title: "Name the Act first", description: "The file is indexed under the name you give it.", variant: "destructive" });
      return;
    }
    try {
      await uploadLaw.mutateAsync({ actName: trimmed, file });
      toast({ title: "Added to the law library", description: `${trimmed} — ${file.name}` });
      onAdded?.(trimmed);
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg" data-testid="add-law-dialog">
        <DialogHeader>
          <DialogTitle>Add a law to the library</DialogTitle>
          <DialogDescription>
            Name the Act with its year. It can be found on official sources and checked before it is indexed, or uploaded as a file you have.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="add-law-name">Act</Label>
          <Input
            id="add-law-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && handleFind()}
            placeholder="e.g. Public Procurement Regulatory Authority Ordinance, 2002"
            disabled={busy}
          />
        </div>
        {notFound && (
          <p className="rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200" data-testid="add-law-not-found">
            {notFound}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleFind} disabled={!trimmed || busy} data-testid="find-law-online">
            {findLaw.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe className="mr-2 h-4 w-4" />}
            {findLaw.isPending ? "Searching official sources…" : "Find on official sources"}
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!trimmed || busy} data-testid="upload-law-file">
            {uploadLaw.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {uploadLaw.isPending ? "Uploading…" : "Upload a PDF or Word file"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) handleUpload(file);
            }}
          />
        </div>
        {findLaw.isPending && (
          <p className="text-xs text-muted-foreground">Searching pakistancode.gov.pk, then other official sites, then downloading and checking the PDF. This can take a minute or two.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
