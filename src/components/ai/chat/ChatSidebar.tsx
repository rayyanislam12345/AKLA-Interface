import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, SquarePen, Trash2 } from "lucide-react";
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

interface ChatSidebarProps {
  matterId: string;
  matterName?: string;
  threads: ChatThread[];
  activeThreadId: string | null;
  // Chats with a reply being written right now, whichever chat is open.
  busyThreadIds?: Set<string>;
  onSelect: (threadId: string | null) => void;
}

function relativeDay(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// The left pane: every conversation on this matter, pinned ones first, with
// rename / pin / archive / delete. "New chat" doesn't create a row — the
// thread appears once the first message is sent, like claude.ai.
export default function ChatSidebar({ matterId, matterName, threads, activeThreadId, busyThreadIds, onSelect }: ChatSidebarProps) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<ChatThread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ChatThread | null>(null);
  const update = useUpdateChatThread(matterId);
  const remove = useDeleteChatThread(matterId);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads.filter((t) => (showArchived ? t.archived : !t.archived) && (!q || (t.title ?? "").toLowerCase().includes(q)));
  }, [threads, query, showArchived]);
  const pinned = visible.filter((t) => t.pinned);
  const recent = visible.filter((t) => !t.pinned);
  const archivedCount = threads.filter((t) => t.archived).length;

  const commitRename = async () => {
    if (renaming && renameValue.trim() && renameValue.trim() !== renaming.title) {
      await update.mutateAsync({ id: renaming.id, title: renameValue.trim() });
    }
    setRenaming(null);
  };

  const Section = ({ label, items }: { label: string; items: ChatThread[] }) =>
    items.length ? (
      <div className="space-y-0.5">
        <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        {items.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeThreadId}
            busy={!!busyThreadIds?.has(t.id)}
            onSelect={() => onSelect(t.id)}
            onRename={() => {
              setRenaming(t);
              setRenameValue(t.title ?? "");
            }}
            onPin={() => update.mutate({ id: t.id, pinned: !t.pinned })}
            onArchive={() => {
              update.mutate({ id: t.id, archived: !t.archived });
              if (t.id === activeThreadId) onSelect(null);
            }}
            onDelete={() => setDeleting(t)}
          />
        ))}
      </div>
    ) : null;

  return (
    <div className="flex h-full flex-col border-r bg-muted/30" data-testid="chat-sidebar">
      <div className="space-y-2 p-3">
        <Button className="w-full justify-start" variant="default" onClick={() => onSelect(null)} data-testid="new-chat">
          <SquarePen className="mr-2 h-4 w-4" />
          New chat
        </Button>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" className="h-8 pl-7 text-sm" />
        </div>
        {matterName && <p className="truncate px-1 text-xs text-muted-foreground" title={matterName}>{matterName}</p>}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {visible.length === 0 && (
          <p className="px-2 pt-6 text-center text-xs text-muted-foreground">
            {showArchived ? "No archived chats." : threads.length ? "No chats match." : "No chats yet — start one below."}
          </p>
        )}
        <Section label="Pinned" items={pinned} />
        <Section label={showArchived ? "Archived" : "Recent"} items={recent} />
      </div>

      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Archive className="h-3.5 w-3.5" />
          {showArchived ? "Back to recent" : `Archived (${archivedCount})`}
        </button>
      )}

      <AlertDialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
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

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.title}" and any documents it produced that haven't been saved to the matter will be removed for everyone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleting) return;
                await remove.mutateAsync(deleting.id);
                if (deleting.id === activeThreadId) onSelect(null);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  busy,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: {
  thread: ChatThread;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 hover:bg-accent",
        active && "bg-accent",
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-2 py-1.5 text-left" data-testid="thread-row">
        <div className="flex items-center gap-1.5">
          {thread.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm">{thread.title || "New chat"}</span>
          {busy && <WritingDots />}
        </div>
        <div className="text-[11px] text-muted-foreground">{relativeDay(thread.last_message_at ?? thread.created_at)}</div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Chat options">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onRename}><Pencil className="mr-2 h-4 w-4" />Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={onPin}>
            {thread.pinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
            {thread.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>
            {thread.archived ? <ArchiveRestore className="mr-2 h-4 w-4" /> : <Archive className="mr-2 h-4 w-4" />}
            {thread.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// The same three dots the transcript shows while a reply is being written,
// small enough for a sidebar row — only on chats that are writing right now.
function WritingDots() {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1" aria-label="Writing a reply" data-testid="thread-busy">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70" />
    </span>
  );
}
