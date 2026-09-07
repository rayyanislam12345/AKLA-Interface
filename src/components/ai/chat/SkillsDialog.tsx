import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type CustomSkill, useCustomSkills, useDeleteCustomSkill, useSaveCustomSkill } from "@/hooks/useChat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

interface SkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Create and edit the firm's custom skills — reusable instruction sets that
// any associate can put in force on a chat with "/". Kept simple on
// purpose: a name, a one-line description for the palette, the
// instructions themselves, and whether the result should open as a document.
export default function SkillsDialog({ open, onOpenChange }: SkillsDialogProps) {
  const { data: skills } = useCustomSkills();
  const save = useSaveCustomSkill();
  const remove = useDeleteCustomSkill();
  const { toast } = useToast();

  const [editing, setEditing] = useState<Partial<CustomSkill> | null>(null);

  const startNew = () => setEditing({ name: "", description: "", instructions: "", produces_document: false });

  const submit = async () => {
    if (!editing?.name?.trim() || !editing.instructions?.trim()) {
      toast({ title: "A skill needs a name and instructions", variant: "destructive" });
      return;
    }
    try {
      await save.mutateAsync({
        id: editing.id,
        name: editing.name.trim(),
        description: editing.description?.trim() ?? "",
        instructions: editing.instructions.trim(),
        produces_document: !!editing.produces_document,
      });
      setEditing(null);
      toast({ title: editing.id ? "Skill updated" : "Skill created" });
    } catch (err: any) {
      toast({ title: "Couldn't save the skill", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setEditing(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Draft, Verify and Summarise are built in. Add the firm's own — a set of instructions the assistant follows when
            you put the skill in force with "/" in the composer.
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <div className="space-y-4" data-testid="skill-form">
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">Name</Label>
              <Input id="skill-name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Board resolution" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-desc">One-line description</Label>
              <Input id="skill-desc" value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="What shows in the skills list" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-instr">Instructions</Label>
              <Textarea
                id="skill-instr"
                rows={8}
                value={editing.instructions ?? ""}
                onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                placeholder="Tell the assistant how to behave when this skill is in force — tone, structure, what to always check, what to never do…"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <div className="text-sm font-medium">Produces a document</div>
                <div className="text-xs text-muted-foreground">The result opens in the document panel and can be saved to the project as a Word file.</div>
              </div>
              <Switch checked={!!editing.produces_document} onCheckedChange={(v) => setEditing({ ...editing, produces_document: v })} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={submit} disabled={save.isPending}>{editing.id ? "Save changes" : "Create skill"}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {!skills?.length && <p className="text-sm text-muted-foreground">No custom skills yet.</p>}
            <ul className="divide-y rounded-md border">
              {skills?.map((s) => (
                <li key={s.id} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">/{s.name}</div>
                    <div className="text-xs text-muted-foreground">{s.description || s.instructions.slice(0, 120)}</div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit skill" onClick={() => setEditing(s)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    aria-label="Delete skill"
                    onClick={() => remove.mutate(s.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button variant="outline" onClick={startNew} data-testid="new-skill">
              <Plus className="mr-2 h-4 w-4" />
              New skill
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
