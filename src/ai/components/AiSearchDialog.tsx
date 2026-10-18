import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, FolderKanban, Loader2, MessageSquare } from "lucide-react";
import { useAiSearch } from "@/hooks/useAiSearch";
import { useRecentChats } from "@/hooks/useChat";
import { useMatters } from "@/hooks/useMatters";
import { searchResultPath } from "@/lib/aiSearch";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

const RECENT_SHOWN = 8;

// The workspace's search (⌘K). With nothing typed it offers recent chats and
// open projects; from two letters on it searches chats, projects and
// documents by title. A chat opens; a project opens its page; a document
// opens its project page with the newest version in the document window.
export default function AiSearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const search = useAiSearch(query);
  const recents = useRecentChats();
  const { data: matters } = useMatters({ openOnly: true });

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  const typed = search.active;
  const chats = typed ? search.results.chats : (recents.data ?? []).slice(0, RECENT_SHOWN).map((t) => ({ id: t.id, title: t.title, matterName: t.matter?.name ?? null }));
  const projects = typed ? search.results.projects : (matters ?? []).slice(0, RECENT_SHOWN).map((m) => ({ id: m.id, name: m.name, clientName: m.client?.name ?? null }));
  const documents = typed ? search.results.documents : [];
  const nothing = !search.searching && chats.length === 0 && projects.length === 0 && documents.length === 0;

  // The server has already matched the typed text; cmdk must not filter the
  // rows again by their id-based values (it would hide every one of them).
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput placeholder="Search chats, projects and documents…" value={query} onValueChange={setQuery} />
      <CommandList data-testid="ai-search-results">
        {search.searching && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
          </div>
        )}
        {search.error ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Couldn't search. Check your connection.{" "}
            <button type="button" className="underline" onClick={() => search.refetch()}>Try again</button>
          </div>
        ) : nothing ? (
          <CommandEmpty>{typed ? "Nothing matches." : "No chats or projects yet."}</CommandEmpty>
        ) : null}
        {chats.length > 0 && (
          <CommandGroup heading={typed ? "Chats" : "Recent chats"}>
            {chats.map((t) => (
              <CommandItem key={t.id} value={`chat-${t.id}`} onSelect={() => go(searchResultPath({ kind: "chat", id: t.id }))}>
                <MessageSquare className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.title || "New chat"}</span>
                {t.matterName && <span className="ml-2 truncate text-xs text-muted-foreground">{t.matterName}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((m) => (
              <CommandItem key={m.id} value={`project-${m.id}`} onSelect={() => go(searchResultPath({ kind: "project", id: m.id }))}>
                <FolderKanban className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{m.name}</span>
                {m.clientName && <span className="ml-2 truncate text-xs text-muted-foreground">{m.clientName}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {documents.length > 0 && (
          <CommandGroup heading="Documents">
            {documents.map((d) => (
              <CommandItem key={d.id} value={`document-${d.id}`} onSelect={() => go(searchResultPath({ kind: "document", matterId: d.matterId, latestVersionId: d.latestVersionId }))}>
                <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{d.title}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">
                  {d.matterName ?? "Project"}{d.versionCount ? ` · ${d.versionCount} version${d.versionCount === 1 ? "" : "s"}` : " · no file yet"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
