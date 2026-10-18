import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, ExternalLink, FolderKanban, Globe, Star } from "lucide-react";
import { isOpenMatter, useMatters } from "@/hooks/useMatters";
import { useStarredMatters } from "@/hooks/useMatterStars";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface ChatScopeChoice {
  matterId?: string;
}

interface ScopePillProps {
  scope: ChatScopeChoice;
  onChange: (scope: ChatScopeChoice) => void;
  // A chat already in a project cannot change scope; the pill then only says which.
  locked?: boolean;
  // The project's name when the page already knows it (a chat's row carries
  // it), so a closed project is still named rather than called "Project".
  label?: string;
  className?: string;
}

// The pill in the composer's toolbar that says what the chat is about: the
// firm in general, or one project (whose documents the AI then reads).
// Gold when a project is chosen, so it is seen.
export default function ScopePill({ scope, onChange, locked = false, label: givenLabel, className }: ScopePillProps) {
  // The picker offers open projects only; the name lookup uses every project,
  // so a chat in a closed one still says which.
  const { data: matters } = useMatters();
  const { data: starred } = useStarredMatters();
  // Starred projects first, then the rest in the list's order.
  const starredFirst = useMemo(() => {
    const open = (matters ?? []).filter(isOpenMatter);
    if (!starred?.size) return open;
    return [...open.filter((m) => starred.has(m.id)), ...open.filter((m) => !starred.has(m.id))];
  }, [matters, starred]);
  const [open, setOpen] = useState(false);
  const current = useMemo(() => matters?.find((m) => m.id === scope.matterId), [matters, scope.matterId]);
  const label = scope.matterId ? (current?.name ?? givenLabel ?? "Project") : "General";
  const Icon = scope.matterId ? FolderKanban : Globe;

  const pillClass = cn(
    "inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
    scope.matterId
      ? "border-[hsl(var(--gold))] bg-[hsl(var(--gold)/0.16)] text-foreground"
      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
    locked && "cursor-default",
    className,
  );

  // Locked: a plain status, still in the tab order and read out, not a
  // disabled button that the keyboard and screen readers skip.
  if (locked) {
    return (
      <span role="status" tabIndex={0} className={pillClass} aria-label={`Scope: ${label}`} data-testid="scope-pill">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={pillClass} aria-label="Change what this chat is about" data-testid="scope-pill">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Find a project…" />
          <CommandList>
            <CommandEmpty>No projects match.</CommandEmpty>
            <CommandGroup heading="Scope">
              <CommandItem
                value="General — no project"
                onSelect={() => {
                  onChange({});
                  setOpen(false);
                }}
              >
                <Check className={cn("mr-2 h-4 w-4", scope.matterId ? "opacity-0" : "opacity-100")} />
                <Globe className="mr-2 h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-sm">General</div>
                  <div className="text-xs text-muted-foreground">The firm's precedents and the law library</div>
                </div>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Projects">
              {starredFirst.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`${m.name} ${m.client?.name ?? ""}`}
                  onSelect={() => {
                    onChange({ matterId: m.id });
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", scope.matterId === m.id ? "opacity-100" : "opacity-0")} />
                  {starred?.has(m.id) ? <Star className="mr-2 h-4 w-4 fill-[hsl(var(--gold))] text-[hsl(var(--gold))]" /> : <FolderKanban className="mr-2 h-4 w-4 text-muted-foreground" />}
                  <div className="min-w-0">
                    <div className="truncate text-sm">{m.name}</div>
                    {m.client?.name && <div className="truncate text-xs text-muted-foreground">{m.client.name}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {scope.matterId && (
          <div className="border-t px-2 py-1.5">
            <Link to={`/ai/p/${scope.matterId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(false)} data-testid="scope-project-link">
              <ExternalLink className="h-3.5 w-3.5" /> Open the project page: its files, chats and instructions
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
