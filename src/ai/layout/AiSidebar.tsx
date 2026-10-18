import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  BookMarked,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Pin,
  Search,
  Settings,
  SquarePen,
  Sun,
  Wand2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useMatters } from "@/hooks/useMatters";
import { chatScopeKey, type ChatThreadWithMatter, useRecentChats } from "@/hooks/useChat";
import { chatStatus, relativeDay } from "@/lib/chatStatus";
import { useAiWorkspace } from "@/ai/AiWorkspaceContext";
import SiteLink from "@/ai/components/SiteLink";
import StatusDot from "@/ai/components/StatusDot";
import ThreadRowMenu from "@/components/ai/chat/ThreadRowMenu";
import SkillsDialog from "@/components/ai/chat/SkillsDialog";
import { LoadState } from "@/components/LoadState";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import aklaMonogram from "@/assets/akla-monogram.png";

const PROJECTS_SHOWN = 6;

function initialsOf(name: string | null | undefined, email: string | undefined) {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/);
    return (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : n.slice(0, 2)).toUpperCase();
  }
  const local = (email ?? "").split("@")[0];
  const parts = local.split(/[._-]/);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase();
}

// The workspace's own left pane. Not shadcn's Sidebar: that one writes the
// cookie and CSS variables the site's AppLayout also reads. On a desktop it
// is a column that collapses to a rail of icons; on a phone the layout puts
// it in a sheet, always expanded.
export default function AiSidebar({ variant }: { variant: "rail" | "sheet" }) {
  const { chat, sidebarCollapsed, setSidebarCollapsed } = useAiWorkspace();
  const collapsed = variant === "rail" && sidebarCollapsed;
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const writing = chat.busyThreadIds.size > 0;
  const recents = useRecentChats({ running: writing });
  const { data: matters, isLoading: mattersLoading, error: mattersError, refetch: refetchMatters } = useMatters({ openOnly: true });
  const projects = useMemo(() => (matters ?? []).slice(0, PROJECTS_SHOWN), [matters]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeThreadId = location.pathname.startsWith("/ai/c/") ? location.pathname.slice("/ai/c/".length) : null;

  const statusOf = (t: ChatThreadWithMatter) =>
    chatStatus({ questionnaire: t.questionnaire, busy: chat.busyThreadIds.has(t.id), failed: !!chat.turnFor(t.id)?.stream.error });

  const search = (
    <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
      <CommandInput placeholder="Search chats and projects…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {!!recents.data?.length && (
          <CommandGroup heading="Chats">
            {recents.data.map((t) => (
              <CommandItem
                key={t.id}
                value={`${t.title ?? "New chat"} ${t.matter?.name ?? ""}`}
                onSelect={() => {
                  setSearchOpen(false);
                  navigate(`/ai/c/${t.id}`);
                }}
              >
                <SquarePen className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="truncate">{t.title || "New chat"}</span>
                {t.matter?.name && <span className="ml-2 truncate text-xs text-muted-foreground">{t.matter.name}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!!matters?.length && (
          <CommandGroup heading="Projects">
            {matters.map((m) => (
              <CommandItem
                key={m.id}
                value={`${m.name} ${m.client?.name ?? ""}`}
                onSelect={() => {
                  setSearchOpen(false);
                  navigate(`/ai?project=${m.id}`);
                }}
              >
                <FolderKanban className="mr-2 h-4 w-4 text-muted-foreground" />
                <span className="truncate">{m.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 bg-sidebar py-2 text-sidebar-foreground" data-testid="ai-sidebar-rail">
        <SiteLink to="/dashboard" className="mb-1 flex h-10 w-10 items-center justify-center rounded-full" title="Back to Project Hub">
          <img src={aklaMonogram} alt="AKLA" className="h-8 w-8 rounded-full object-cover" />
        </SiteLink>
        <RailButton label="Expand sidebar" onClick={() => setSidebarCollapsed(false)}><ChevronsRight className="h-4 w-4" /></RailButton>
        <RailButton label="New chat" onClick={() => navigate("/ai")} testId="new-chat"><SquarePen className="h-4 w-4" /></RailButton>
        <RailButton label="Search (⌘K)" onClick={() => setSearchOpen(true)}><Search className="h-4 w-4" /></RailButton>
        <RailButton label="Projects" onClick={() => setSidebarCollapsed(false)}><FolderKanban className="h-4 w-4" /></RailButton>
        <SiteLink to="/precedent-library" className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-sidebar-accent" title="Firm Library">
          <BookMarked className="h-4 w-4" />
        </SiteLink>
        <div className="flex-1" />
        <UserMenu collapsed />
        {search}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground" data-testid="ai-sidebar">
      <div className="flex h-12 items-center gap-2 px-3">
        <SiteLink to="/dashboard" className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 hover:bg-sidebar-accent" title="Back to Project Hub">
          <img src={aklaMonogram} alt="AKLA" className="h-7 w-7 shrink-0 rounded-full object-cover" />
          <span className="truncate text-sm font-medium">Project Hub</span>
        </SiteLink>
        <div className="flex-1" />
        {variant === "rail" && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSidebarCollapsed(true)} aria-label="Collapse sidebar">
            <ChevronsLeft className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="space-y-1 px-3 pb-2">
        <Button className="w-full justify-start" onClick={() => navigate("/ai")} data-testid="new-chat">
          <SquarePen className="mr-2 h-4 w-4" />
          New chat
        </Button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          Search
          <kbd className="ml-auto hidden rounded border px-1 text-[10px] md:inline">⌘K</kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <SectionLabel>Projects</SectionLabel>
        <LoadState isLoading={mattersLoading} error={mattersError} onRetry={() => refetchMatters()} what="projects" compact isEmpty={projects.length === 0} empty={<p className="px-2 text-xs text-muted-foreground">No open projects.</p>}>
          <ul className="space-y-0.5">
            {projects.map((m) => (
              <li key={m.id}>
                <Link
                  to={`/ai?project=${m.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
                  title={`Start a chat in ${m.name}`}
                >
                  <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{m.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </LoadState>
        <SiteLink to="/matters" className="mt-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
          All projects on Project Hub
        </SiteLink>

        <SectionLabel>Library</SectionLabel>
        <SiteLink to="/precedent-library" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent">
          <BookMarked className="h-4 w-4 shrink-0 text-muted-foreground" />
          Firm Library
        </SiteLink>
        <button type="button" onClick={() => setSkillsOpen(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent">
          <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          Skills
        </button>

        <SectionLabel>Recents</SectionLabel>
        <LoadState
          isLoading={recents.isLoading}
          error={recents.error}
          onRetry={() => recents.refetch()}
          what="chats"
          compact
          isEmpty={(recents.data?.length ?? 0) === 0}
          empty={<p className="px-2 text-xs text-muted-foreground">No chats yet. Start one above.</p>}
        >
          <ul className="space-y-0.5" data-testid="recent-chats">
            {(recents.data ?? []).map((t) => (
              <RecentRow
                key={t.id}
                thread={t}
                active={t.id === activeThreadId}
                status={statusOf(t)}
                scopeKey={chatScopeKey(t.matter_id ? { matterId: t.matter_id } : { general: user?.id ?? "" })}
                onGone={() => {
                  if (t.id === activeThreadId) navigate("/ai");
                }}
              />
            ))}
          </ul>
        </LoadState>
      </div>

      <UserMenu />
      {search}
      <SkillsDialog open={skillsOpen} onOpenChange={setSkillsOpen} />
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function RailButton({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onClick} aria-label={label} title={label} data-testid={testId}>
      {children}
    </Button>
  );
}

function RecentRow({
  thread,
  active,
  status,
  scopeKey,
  onGone,
}: {
  thread: ChatThreadWithMatter;
  active: boolean;
  status: ReturnType<typeof chatStatus>;
  scopeKey: string;
  onGone: () => void;
}) {
  return (
    <li className={cn("group flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent", active && "bg-sidebar-accent")}>
      <Link to={`/ai/c/${thread.id}`} className="min-w-0 flex-1 px-2 py-1.5" data-testid="thread-row">
        <div className="flex items-center gap-1.5">
          {thread.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm">{thread.title || "New chat"}</span>
          <span className="ml-auto flex shrink-0 items-center pl-1">
            <StatusDot status={status} />
          </span>
        </div>
        <div className="truncate text-[11px] text-muted-foreground" data-testid="thread-meta">
          {thread.matter?.name ?? "General"} · {relativeDay(thread.last_message_at ?? thread.created_at)}
        </div>
      </Link>
      <ThreadRowMenu thread={thread} scopeKey={scopeKey} canDelete onArchived={onGone} onDeleted={onGone} />
    </li>
  );
}

function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { user, signOut } = useAuth();
  const { data: profile } = useMyProfile();
  const { theme, setTheme } = useTheme();
  const { chat } = useAiWorkspace();
  const writing = chat.busyThreadIds.size > 0;
  const initials = initialsOf(profile?.full_name, user?.email);
  const name = profile?.full_name || user?.email || "";
  return (
    <div className={cn("border-t border-sidebar-border", collapsed ? "p-1" : "p-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn("flex w-full items-center gap-2 rounded-md hover:bg-sidebar-accent", collapsed ? "justify-center p-1" : "px-2 py-1.5 text-left")}
            aria-label="Account menu"
            data-testid="ai-user-menu"
          >
            <Avatar className="h-7 w-7">
              <AvatarFallback className="bg-[hsl(var(--gold)/0.25)] text-xs font-medium text-foreground">{initials}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                <MoreHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <SiteLink to="/dashboard" className="cursor-pointer"><ArrowLeft className="mr-2 h-4 w-4" />Back to Project Hub</SiteLink>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <SiteLink to="/settings" className="cursor-pointer"><Settings className="mr-2 h-4 w-4" />Settings</SiteLink>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {theme === "dark" ? <Moon className="mr-2 h-4 w-4" /> : theme === "light" ? <Sun className="mr-2 h-4 w-4" /> : <Monitor className="mr-2 h-4 w-4" />}
              Appearance
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="light"><Sun className="mr-2 h-4 w-4" />Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon className="mr-2 h-4 w-4" />Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system"><Monitor className="mr-2 h-4 w-4" />Same as the device</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (writing && !window.confirm("A reply is still being written. Signing out stops it. Sign out anyway?")) return;
              void signOut();
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
