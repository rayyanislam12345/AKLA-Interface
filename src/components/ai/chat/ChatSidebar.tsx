import { useMemo, useState } from "react";
import { Archive, Pin, Search, SquarePen } from "lucide-react";
import type { ChatThread } from "@/hooks/useChat";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile, useProfiles } from "@/hooks/useProfiles";
import ThreadRowMenu from "@/components/ai/chat/ThreadRowMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface ChatSidebarProps {
  // chatScopeKey(scope): which threads list the actions refresh.
  scopeKey: string;
  subtitle?: string;
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
export default function ChatSidebar({ scopeKey, subtitle, threads, activeThreadId, busyThreadIds, onSelect }: ChatSidebarProps) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // A project's chats are shared by everyone on it: each row says whose it
  // is when it is not yours, "Mine" narrows the list to your own, and only
  // the person who started a chat, or an administrator, can delete it.
  const { user } = useAuth();
  const { data: me } = useMyProfile();
  const { data: profiles } = useProfiles();
  const isAdmin = me?.role === "admin" || me?.role === "founder";
  const [mineOnly, setMineOnly] = useState(false);
  const othersChats = threads.some((t) => t.created_by && t.created_by !== user?.id);
  const authorName = (t: ChatThread) => {
    if (!t.created_by || t.created_by === user?.id) return null;
    const p = profiles?.find((x) => x.id === t.created_by);
    return p?.full_name || p?.email || "A colleague";
  };
  const mayDelete = (t: ChatThread) => isAdmin || (!!user?.id && t.created_by === user.id);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads.filter(
      (t) =>
        (showArchived ? t.archived : !t.archived) &&
        (!q || (t.title ?? "").toLowerCase().includes(q)) &&
        (!mineOnly || t.created_by === user?.id),
    );
  }, [threads, query, showArchived, mineOnly, user?.id]);
  const pinned = visible.filter((t) => t.pinned);
  const recent = visible.filter((t) => !t.pinned);
  const archivedCount = threads.filter((t) => t.archived).length;

  const sectionProps = { scopeKey, activeThreadId, busyThreadIds, authorName, mayDelete, onSelect };

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
        {subtitle && <p className="truncate px-1 text-xs text-muted-foreground" title={subtitle}>{subtitle}</p>}
        {(othersChats || mineOnly) && (
          <div className="flex gap-1 px-1" role="group" aria-label="Whose chats">
            <Button size="sm" variant={mineOnly ? "ghost" : "secondary"} className="h-6 px-2 text-xs" onClick={() => setMineOnly(false)} aria-pressed={!mineOnly}>
              Everyone's
            </Button>
            <Button size="sm" variant={mineOnly ? "secondary" : "ghost"} className="h-6 px-2 text-xs" onClick={() => setMineOnly(true)} aria-pressed={mineOnly} data-testid="mine-filter">
              Mine
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {visible.length === 0 && (
          <p className="px-2 pt-6 text-center text-xs text-muted-foreground">
            {showArchived ? "No archived chats." : mineOnly && threads.length ? "None of your chats match." : threads.length ? "No chats match." : "No chats yet — start one below."}
          </p>
        )}
        <Section label="Pinned" items={pinned} {...sectionProps} />
        <Section label={showArchived ? "Archived" : "Recent"} items={recent} {...sectionProps} />
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
    </div>
  );
}

// A module-level component (not one made inside ChatSidebar's render), so
// the rows keep their identity across re-renders: each row's "…" menu holds
// its own Rename / Delete dialog, which a remount would close mid-typing.
function Section({
  label,
  items,
  scopeKey,
  activeThreadId,
  busyThreadIds,
  authorName,
  mayDelete,
  onSelect,
}: {
  label: string;
  items: ChatThread[];
  scopeKey: string;
  activeThreadId: string | null;
  busyThreadIds?: Set<string>;
  authorName: (t: ChatThread) => string | null;
  mayDelete: (t: ChatThread) => boolean;
  onSelect: (threadId: string | null) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-0.5">
      <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {items.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          scopeKey={scopeKey}
          active={t.id === activeThreadId}
          busy={!!busyThreadIds?.has(t.id)}
          author={authorName(t)}
          canDelete={mayDelete(t)}
          onSelect={() => onSelect(t.id)}
          onGone={() => {
            if (t.id === activeThreadId) onSelect(null);
          }}
        />
      ))}
    </div>
  );
}

function ThreadRow({
  thread,
  scopeKey,
  active,
  busy,
  author,
  canDelete,
  onSelect,
  onGone,
}: {
  thread: ChatThread;
  scopeKey: string;
  active: boolean;
  busy: boolean;
  // Who started the chat, when it was not you.
  author: string | null;
  canDelete: boolean;
  onSelect: () => void;
  // The chat was archived or deleted.
  onGone: () => void;
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
        <div className="truncate text-[11px] text-muted-foreground" data-testid="thread-meta">
          {relativeDay(thread.last_message_at ?? thread.created_at)}
          {author && <> · {author}</>}
        </div>
      </button>
      <ThreadRowMenu thread={thread} scopeKey={scopeKey} author={author} canDelete={canDelete} onArchived={onGone} onDeleted={onGone} />
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
