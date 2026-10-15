import { useMemo, useState } from "react";
import { FolderKanban, Search } from "lucide-react";
import { useMatters } from "@/hooks/useMatters";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (matterId: string) => void;
  title: string;
  description?: string;
}

// Asks which project, when an action from the AI Assistant needs one:
// reviewing or editing a project's document happens inside that project's
// workspace, where its files and context are. One question, then hand over.
export default function ProjectPickerDialog({ open, onOpenChange, onPick, title, description }: ProjectPickerDialogProps) {
  const { data: matters } = useMatters({ openOnly: true });
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = matters ?? [];
    return q ? all.filter((m) => m.name.toLowerCase().includes(q)) : all;
  }, [matters, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a project…" className="pl-8" />
        </div>
        <ul className="max-h-72 overflow-y-auto divide-y rounded-md border">
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No projects match.</li>}
          {rows.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onPick(m.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
