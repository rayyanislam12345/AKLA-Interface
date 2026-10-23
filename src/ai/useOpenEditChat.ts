import { friendlyError } from "@/lib/friendlyError";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { openDocumentForEdit, type EditTarget } from "@/hooks/useChat";
import { openParam } from "@/lib/aiLinks";

// "Edit with AI" anywhere in the workspace: the chosen version opens in a
// chat of its own, already on screen beside the composer, and the lawyer
// says what to change. Shared by the prompt box, the document window and
// the full-page document view.
export function useOpenEditChat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const { toast } = useToast();
  return useCallback(
    async (matterId: string, target: EditTarget) => {
      try {
        const { threadId, artifact } = await openDocumentForEdit(matterId, target, me?.id);
        queryClient.setQueryData(["chat-artifacts", threadId], [artifact]);
        queryClient.invalidateQueries({ queryKey: ["chat-recent"] });
        queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] });
        navigate(`/ai/c/${threadId}?open=${openParam({ kind: "artifact", id: artifact.id })}`);
      } catch (err) {
        toast({ title: "Couldn't open that document", description: friendlyError(err), variant: "destructive" });
      }
    },
    [navigate, queryClient, me?.id, toast],
  );
}
