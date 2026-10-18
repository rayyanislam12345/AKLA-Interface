import { useState } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { type ChatThread, useDeleteChatThread, useUpdateChatThread } from "@/hooks/useChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface ThreadRowMenuProps {
  thread: ChatThread;
  // chatScopeKey(scope): which threads list the actions refresh.
  scopeKey: string;
  // Who started the chat, when it was not you (named in the delete prompt).
  author?: string | null;
  // Only the person who started a chat, or an administrator, may delete it.
  canDelete: boolean;
  // Called as soon as the chat is archived or deleted, so a sidebar showing
  // it as the open chat can move away from it.
  onArchived?: () => void;
  onDeleted?: () => void;
  className?: string;
}

// The "…" menu on a chat row — rename, pin, archive, delete, with the
// confirmations — shared by the site's chat list and the new workspace's
// sidebar, so both behave the same.
export default function ThreadRowMenu({ thread, scopeKey, author, canDelete, onArchived, onDeleted, className }: ThreadRowMenuProps) {
  const update = useUpdateChatThread(scopeKey);
  const remove = useDeleteChatThread(scopeKey);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState(false);

  const commitRename = async () => {
    if (renameValue.trim() && renameValue.trim() !== thread.title) {
      await update.mutateAsync({ id: thread.id, title: renameValue.trim() });
    }
    setRenaming(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            // Shown on hover, while open, when the row or the button has
            // keyboard focus, and always where there is no hover (phones).
            className={cn(
              "h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
              className,
            )}
            aria-label="Chat options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setRenameValue(thread.title ?? "");
              setRenaming(true);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => update.mutate({ id: thread.id, pinned: !thread.pinned })}>
            {thread.pinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
            {thread.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              update.mutate({ id: thread.id, archived: !thread.archived });
              onArchived?.();
            }}
          >
            {thread.archived ? <ArchiveRestore className="mr-2 h-4 w-4" /> : <Archive className="mr-2 h-4 w-4" />}
            {thread.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={renaming} onOpenChange={(o) => !o && setRenaming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename chat</AlertDialogTitle>
            <AlertDialogDescription>Give this conversation a name you'll recognise later.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitRename()}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={commitRename}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={(o) => !o && setDeleting(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              "{thread.title}"{author ? `, started by ${author},` : ""} and any documents it produced that haven't been saved to the project will be removed for everyone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                await remove.mutateAsync(thread.id);
                onDeleted?.();
                setDeleting(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
