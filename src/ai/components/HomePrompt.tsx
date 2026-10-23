import { friendlyError } from "@/lib/friendlyError";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import type { ActiveSkill, ChatAttachment, EditTarget } from "@/hooks/useChat";
import { NEW_CHAT_PATH, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import { useOpenEditChat } from "@/ai/useOpenEditChat";
import ScopePill, { type ChatScopeChoice } from "@/ai/components/ScopePill";
import Composer from "@/components/ai/chat/Composer";

interface HomePromptProps {
  scope: ChatScopeChoice;
  /** Absent, or `locked`, when the page is already about one project. */
  onScopeChange?: (scope: ChatScopeChoice) => void;
  locked?: boolean;
  /** The project's name when the page already knows it. */
  scopeLabel?: string;
  skill: ActiveSkill | null;
  seedText?: string;
  /** Files put in the box by the page: a version from "Ask about this", a Review link's document. */
  seedAttachments?: ChatAttachment[];
  editPickerOpen: boolean;
  onEditPickerOpenChange: (open: boolean) => void;
  onNeedsProject: (purpose: "review" | "edit") => void;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onTextChange?: (text: string) => void;
  autoFocus?: boolean;
}

// The prompt box on Home and on a project page: the composer with the scope
// pill in its toolbar. Sending starts a new chat and moves to it; the reply
// is written by the workspace's one chat engine, so it carries on wherever
// the lawyer goes next. Edit opens the chosen version in a chat of its own.
export default function HomePrompt({
  scope,
  onScopeChange,
  locked = false,
  scopeLabel,
  skill,
  seedText,
  seedAttachments,
  editPickerOpen,
  onEditPickerOpenChange,
  onNeedsProject,
  onAttachmentsChange,
  onTextChange,
  autoFocus = false,
}: HomePromptProps) {
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { chat } = useAiWorkspace();
  const { toast } = useToast();
  const openEdit = useOpenEditChat();
  const matterId = scope.matterId;

  const handleSend = async (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => {
    if (chat.turnFor(null)?.inFlight) {
      toast({ title: "A new chat is still being started", description: "Give it a moment; you'll find it in Recents.", variant: "destructive" });
      return;
    }
    chat.send({ matterId, general: matterId ? undefined : me?.id, threadId: null, ...input }).catch((err: Error) => {
      toast({ title: "Couldn't send", description: friendlyError(err), variant: "destructive" });
    });
    navigate(matterId ? `${NEW_CHAT_PATH}?matter=${matterId}` : NEW_CHAT_PATH);
  };

  const handleEditDocument = (target: EditTarget) => {
    if (matterId) void openEdit(matterId, target);
  };

  return (
    <Composer
      // Files upload under the scope they were added in, so a scope change starts afresh.
      key={matterId ?? "general"}
      matterId={matterId}
      sending={false}
      initialText={seedText}
      initialSkill={skill}
      initialAttachments={seedAttachments}
      onSend={handleSend}
      onStop={() => undefined}
      onEditDocument={handleEditDocument}
      editPickerOpen={editPickerOpen}
      onEditPickerOpenChange={onEditPickerOpenChange}
      onNeedsProject={onNeedsProject}
      onAttachmentsChange={onAttachmentsChange}
      onTextChange={onTextChange}
      appearance="ai"
      toolbar={<ScopePill scope={scope} label={scopeLabel} onChange={onScopeChange ?? (() => undefined)} locked={locked || !onScopeChange} />}
      autoFocus={autoFocus}
    />
  );
}
