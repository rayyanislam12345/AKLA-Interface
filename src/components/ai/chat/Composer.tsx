import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, FileText, FolderOpen, Loader2, Paperclip, Plus, ScanSearch, Settings2, Sparkles, Square, StickyNote, Wand2, X } from "lucide-react";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { type ActiveSkill, type ChatAttachment, useCustomSkills, uploadChatFile } from "@/hooks/useChat";
import { UPLOAD_ACCEPT } from "@/components/ai/DocumentUploadCard";
import AddFromMatterDialog from "@/components/ai/chat/AddFromMatterDialog";
import SkillsDialog from "@/components/ai/chat/SkillsDialog";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface ComposerProps {
  matterId: string;
  sending: boolean;
  initialText?: string;
  initialSkill?: ActiveSkill | null;
  initialAttachments?: ChatAttachment[];
  onSend: (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => Promise<void> | void;
  onStop: () => void;
  onSkillChange?: (skill: ActiveSkill | null) => void;
}

type PendingAttachment = ChatAttachment & { uploading?: boolean; error?: string };

const BUILT_IN = [
  { key: "draft" as const, label: "Draft", description: "Interview, then draft a document of a chosen type", Icon: Sparkles },
  { key: "verify" as const, label: "Verify", description: "Three-pass review of a project document (legal, formatting, conflicts)", Icon: ScanSearch },
  { key: "summarise" as const, label: "Summarise", description: "A short \"Notes On …\" memo about the attached document", Icon: StickyNote },
];

// The claude.ai-style composer: a text box that grows as you type, a "+"
// menu for attaching files (upload, or one of the matter's own documents)
// and choosing a skill, "/" for the skills palette, drag-and-drop and paste
// for files, and chips for what's attached and which skill is in force.
export default function Composer({
  matterId,
  sending,
  initialText,
  initialSkill,
  initialAttachments,
  onSend,
  onStop,
  onSkillChange,
}: ComposerProps) {
  const { toast } = useToast();
  const { data: documentTypes } = useDocumentTypes();
  const { data: customSkills } = useCustomSkills();

  const [text, setText] = useState(initialText ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>(initialAttachments ?? []);
  const [skill, setSkillState] = useState<ActiveSkill | null>(initialSkill ?? null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [addFromMatterOpen, setAddFromMatterOpen] = useState(false);
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setSkill = (next: ActiveSkill | null) => {
    setSkillState(next);
    onSkillChange?.(next);
  };

  // Seeds from the URL (a Revise link, a "Draft with AI" button) arrive after
  // first render, so mirror them in when they change.
  useEffect(() => {
    if (initialText !== undefined) setText(initialText);
  }, [initialText]);
  useEffect(() => {
    if (initialSkill !== undefined) setSkillState(initialSkill);
  }, [initialSkill]);
  useEffect(() => {
    if (initialAttachments) setAttachments(initialAttachments);
  }, [initialAttachments]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const typesByCategory = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof documentTypes>>();
    for (const t of documentTypes ?? []) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
    return Array.from(groups.entries());
  }, [documentTypes]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const placeholders: PendingAttachment[] = list.map((f) => ({ bucket: "ai-chat-files", path: `pending-${f.name}-${f.size}`, name: f.name, size: f.size, type: f.type, uploading: true }));
    setAttachments((prev) => [...prev, ...placeholders]);
    await Promise.all(
      list.map(async (file, i) => {
        try {
          const uploaded = await uploadChatFile(matterId, file);
          setAttachments((prev) => prev.map((a) => (a.path === placeholders[i].path ? uploaded : a)));
        } catch (err: any) {
          setAttachments((prev) => prev.filter((a) => a.path !== placeholders[i].path));
          toast({ title: `Couldn't attach ${file.name}`, description: err.message, variant: "destructive" });
        }
      }),
    );
  };

  const removeAttachment = (path: string) => setAttachments((prev) => prev.filter((a) => a.path !== path));

  const applySkill = (next: ActiveSkill) => {
    setSkill(next);
    // "/draft" typed in the box shouldn't be sent as text.
    setText((t) => (t.startsWith("/") ? "" : t));
    setSlashOpen(false);
    textareaRef.current?.focus();
  };

  const uploading = attachments.some((a) => a.uploading);
  const needsDocType = skill?.key === "draft" && !skill.documentTypeId;
  const canSend = !sending && !uploading && !needsDocType && (text.trim().length > 0 || attachments.length > 0);

  const submit = async () => {
    if (!canSend) return;
    const message = text.trim();
    const ready = attachments.filter((a) => !a.uploading);
    setText("");
    setAttachments([]);
    await onSend({ message, attachments: ready, skill });
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) return; // the palette owns the keys
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    setSlashOpen(v.startsWith("/") && !v.includes(" ") && v.length < 30);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const SkillIcon = skill ? (BUILT_IN.find((b) => b.key === skill.key)?.Icon ?? Wand2) : Wand2;

  return (
    <div className="px-4 pb-4 pt-2 md:px-8">
      <div
        className={cn(
          "mx-auto max-w-3xl rounded-2xl border bg-background shadow-sm transition-colors focus-within:border-primary/50",
          dragging && "border-primary bg-primary/5",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        data-testid="composer"
      >
        {(attachments.length > 0 || skill) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {skill && (
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs font-medium" data-testid="skill-chip">
                <SkillIcon className="h-3 w-3" />
                {skill.label}
                <button type="button" aria-label="Remove skill" className="ml-0.5 rounded hover:bg-primary/20" onClick={() => setSkill(null)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {attachments.map((a) => (
              <span key={a.path} className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs" data-testid="attachment-chip">
                {a.uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : a.versionId ? <FileText className="h-3 w-3" /> : <Paperclip className="h-3 w-3" />}
                <span className="max-w-[200px] truncate">{a.name}</span>
                <button type="button" aria-label={`Remove ${a.name}`} className="ml-0.5 rounded hover:bg-background" onClick={() => removeAttachment(a.path)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {needsDocType && (
          <div className="px-3 pt-3">
            <Select onValueChange={(id) => setSkill({ key: "draft", documentTypeId: id, label: `Draft · ${documentTypes?.find((t) => t.id === id)?.name ?? ""}` })}>
              <SelectTrigger className="h-9" data-testid="draft-type-select">
                <SelectValue placeholder="Which document type should this draft be?" />
              </SelectTrigger>
              <SelectContent>
                {typesByCategory.map(([category, types]) => (
                  <SelectGroup key={category}>
                    <SelectLabel>{category}</SelectLabel>
                    {types.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Popover open={slashOpen} onOpenChange={setSlashOpen}>
          <PopoverAnchor asChild>
            <div className="px-3 pt-2">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                rows={1}
                placeholder={
                  skill?.key === "draft"
                    ? "Describe the deal, or just say \"draft it\"…"
                    : skill?.key === "verify"
                      ? "Attach a project document and press send to review it…"
                      : "Ask about this project, or type / for skills…"
                }
                className="max-h-60 min-h-[44px] w-full resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground"
                data-testid="composer-input"
              />
            </div>
          </PopoverAnchor>
          <PopoverContent align="start" className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            <Command>
              <CommandInput placeholder="Search skills…" value={text.replace(/^\//, "")} onValueChange={(v) => setText("/" + v)} />
              <CommandList>
                <CommandEmpty>No skill matches.</CommandEmpty>
                <CommandGroup heading="Built in">
                  {BUILT_IN.map((b) => (
                    <CommandItem key={b.key} value={b.label} onSelect={() => applySkill({ key: b.key, label: b.label })}>
                      <b.Icon className="mr-2 h-4 w-4" />
                      <div>
                        <div className="text-sm">{b.label}</div>
                        <div className="text-xs text-muted-foreground">{b.description}</div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {!!customSkills?.length && (
                  <CommandGroup heading="Firm skills">
                    {customSkills.map((s) => (
                      <CommandItem key={s.id} value={s.name} onSelect={() => applySkill({ key: "custom", customSkillId: s.id, label: s.name })}>
                        <Wand2 className="mr-2 h-4 w-4" />
                        <div>
                          <div className="text-sm">{s.name}</div>
                          {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label="Attach or choose a skill" data-testid="composer-plus">
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                  <Paperclip className="mr-2 h-4 w-4" />Upload a file
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAddFromMatterOpen(true)}>
                  <FolderOpen className="mr-2 h-4 w-4" />Add from project
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Skills</DropdownMenuLabel>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger><Sparkles className="mr-2 h-4 w-4" />Draft a document</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                    {typesByCategory.map(([category, types]) => (
                      <div key={category}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">{category}</DropdownMenuLabel>
                        {types.map((t) => (
                          <DropdownMenuItem key={t.id} onClick={() => applySkill({ key: "draft", documentTypeId: t.id, label: `Draft · ${t.name}` })}>
                            {t.name}
                          </DropdownMenuItem>
                        ))}
                      </div>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => applySkill({ key: "verify", label: "Verify" })}>
                  <ScanSearch className="mr-2 h-4 w-4" />Verify a document
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => applySkill({ key: "summarise", label: "Summarise" })}>
                  <StickyNote className="mr-2 h-4 w-4" />Summarise
                </DropdownMenuItem>
                {!!customSkills?.length && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger><Wand2 className="mr-2 h-4 w-4" />Firm skills</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                      {customSkills.map((s) => (
                        <DropdownMenuItem key={s.id} onClick={() => applySkill({ key: "custom", customSkillId: s.id, label: s.name })}>
                          {s.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setSkillsDialogOpen(true)}>
                  <Settings2 className="mr-2 h-4 w-4" />Manage skills
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">Enter to send · Shift+Enter for a new line · / for skills</span>
          </div>

          {sending ? (
            <Button type="button" size="icon" variant="secondary" className="h-8 w-8 rounded-full" onClick={onStop} aria-label="Stop">
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button type="button" size="icon" className="h-8 w-8 rounded-full" onClick={submit} disabled={!canSend} aria-label="Send" data-testid="composer-send">
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT + ",.txt,.md,.csv"}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <AddFromMatterDialog
        matterId={matterId}
        open={addFromMatterOpen}
        onOpenChange={setAddFromMatterOpen}
        onPick={(a) => setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]))}
      />
      <SkillsDialog open={skillsDialogOpen} onOpenChange={setSkillsDialogOpen} />
    </div>
  );
}
