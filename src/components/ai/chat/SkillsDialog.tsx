import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { type CustomSkill, useCustomSkills, useDeleteCustomSkill, useSaveCustomSkill } from "@/hooks/useChat";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
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

// A skill uploaded as a Claude skill .zip, as opposed to one written here.
type UploadedSkill = CustomSkill & { kind?: string; skill_files?: Array<{ path: string; size: number }> };
const isUploaded = (s: CustomSkill) => (s as UploadedSkill).kind === "claude_skill";

async function callSkillsService(path: string, init: RequestInit) {
  const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
  if (!base) throw new Error("Uploading skills needs the AI chat service, which is not configured here.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const resp = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.error ?? `Request failed (${resp.status})`);
  return payload;
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
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const uploadZip = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast({ title: "Choose a .zip file", description: "A Claude skill is uploaded as the zip of its folder, with SKILL.md inside.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const { skill, replaced, renamed } = await callSkillsService("/skills/upload", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
      await queryClient.invalidateQueries({ queryKey: ["ai-skills"] });
      const renames = (renamed ?? []) as Array<{ from: string; to: string }>;
      toast({
        title: replaced ? `Updated /${skill.name}` : `Added /${skill.name}`,
        description:
          `${skill.skill_files?.length ?? 0} files. Put it in force with "/" in the composer.` +
          (renames.length ? ` ${renames.length} file name${renames.length === 1 ? " was" : "s were"} simplified for upload (${renames.map((r) => r.to.split("/").pop()).join(", ")}), and the skill's references to ${renames.length === 1 ? "it" : "them"} updated.` : ""),
      });
    } catch (err: any) {
      toast({ title: "Couldn't upload the skill", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const deleteSkill = async (skill: CustomSkill) => {
    if (!isUploaded(skill)) return remove.mutate(skill.id);
    setDeletingId(skill.id);
    try {
      await callSkillsService("/skills/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: skill.id }) });
      await queryClient.invalidateQueries({ queryKey: ["ai-skills"] });
    } catch (err: any) {
      toast({ title: "Couldn't remove the skill", description: err.message, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

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
            Draft, Review and Summarise are built in. Add the firm's own: write a set of instructions here, or upload a
            Claude skill as a .zip. An uploaded skill runs its own scripts and templates and hands back the files it builds.
            Put either in force with "/" in the composer.
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
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      /{s.name}
                      {isUploaded(s) && (
                        <Badge variant="secondary" className="text-[10px] font-normal">
                          Uploaded skill · {(s as UploadedSkill).skill_files?.length ?? 0} files
                        </Badge>
                      )}
                    </div>
                    <div className="line-clamp-3 text-xs text-muted-foreground">{s.description || s.instructions.slice(0, 120)}</div>
                  </div>
                  {!isUploaded(s) && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit skill" onClick={() => setEditing(s)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    aria-label="Delete skill"
                    disabled={deletingId === s.id}
                    onClick={() => deleteSkill(s)}
                  >
                    {deletingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={startNew} data-testid="new-skill">
                <Plus className="mr-2 h-4 w-4" />
                New skill
              </Button>
              <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading} data-testid="upload-skill">
                {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {uploading ? "Uploading…" : "Upload skill (.zip)"}
              </Button>
              <input ref={fileInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => uploadZip(e.target.files?.[0])} />
            </div>
            <p className="text-xs text-muted-foreground">Uploading a skill with the same name as one already here replaces it with the new version.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
