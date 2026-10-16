import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FolderPlus, Loader2 } from "lucide-react";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import { type ChatAttachment, projectOfChatFile, saveChatFileToProject, useChatFileSaveState } from "@/hooks/useChat";
import { useMatters } from "@/hooks/useMatters";
import { useToast } from "@/hooks/use-toast";
import { describeIndexing, describeSave } from "@/lib/saveFileToProject";
import { cn } from "@/lib/utils";

// "Save to project" on a file the lawyer put into the chat. In a project
// chat (the file sits under that project's prefix) it saves straight to that
// project; anywhere else it first asks which project. Afterwards the chip
// says where the file went and links there.
// `canOpen` false (the composer) keeps "Saved to …" from leaving the page
// with a message half-written.
export default function SaveAttachmentToProject({ attachment, className, canOpen = true }: { attachment: ChatAttachment; className?: string; canOpen?: boolean }) {
  const { saving, saved } = useChatFileSaveState(attachment);
  const { data: matters } = useMatters();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const chatProject = projectOfChatFile(attachment.path);
  const nameOf = (id: string) => matters?.find((m) => m.id === id)?.name ?? "the project";

  if (attachment.bucket !== "ai-chat-files") return null;

  const save = async (matterId: string) => {
    const matterName = nameOf(matterId);
    try {
      const result = await saveChatFileToProject(attachment, matterId, matterName);
      if (!result) return; // already being saved
      toast(describeSave(result, matterName));
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["chat-file-in-project", attachment.path] });
      result.indexing?.then((outcome) => {
        queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
        const note = describeIndexing(outcome, result.title);
        if (note) toast({ title: "Saved, with a note", description: note });
      });
    } catch (err) {
      toast({ title: `Could not save "${attachment.name}"`, description: (err as Error).message, variant: "destructive" });
    }
  };

  if (saved) {
    const where = saved.matterName || nameOf(saved.matterId);
    return (
      <button
        type="button"
        className={cn("inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-emerald-700 dark:text-emerald-400", canOpen && "hover:underline", className)}
        title={`"${saved.title}" in ${where}'s documents.${canOpen ? " Open the project." : ""}`}
        onClick={canOpen ? () => navigate(`/matters/${saved.matterId}`) : undefined}
        data-testid="attachment-saved"
      >
        <Check className="h-3 w-3" />
        <span className="max-w-[160px] truncate">Saved to {where}</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={saving}
        className={cn("inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-60", className)}
        title={chatProject ? `Save to ${nameOf(chatProject)}'s documents` : "Save to a project's documents"}
        onClick={() => (chatProject ? save(chatProject) : setPickerOpen(true))}
        data-testid="attachment-save-to-project"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderPlus className="h-3 w-3" />}
        {saving ? "Saving…" : "Save to project"}
      </button>
      {!chatProject && (
        <ProjectPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title="Save to which project?"
          description={`"${attachment.name}" will be added to that project's documents.`}
          onPick={(id) => {
            setPickerOpen(false);
            void save(id);
          }}
        />
      )}
    </>
  );
}
