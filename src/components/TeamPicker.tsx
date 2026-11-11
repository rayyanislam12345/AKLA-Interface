import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

interface TeamPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** The firm's approved members, by full name. Anyone else is typed in. */
  options: string[];
  id?: string;
}

/**
 * The Team cell: names as chips, added from the firm's people or typed, as
 * the sheet has always held names the Hub does not know (an EY team, a
 * consultant).
 */
export function TeamPicker({ value, onChange, options, id }: TeamPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const chosen = new Set(value.map((v) => v.toLowerCase()));
  const add = (name: string) => {
    const n = name.trim();
    if (!n || chosen.has(n.toLowerCase())) return;
    onChange([...value, n]);
    setQuery("");
    setOpen(false);
  };
  const typedIsNew = !!query.trim() && !options.some((o) => o.toLowerCase() === query.trim().toLowerCase()) && !chosen.has(query.trim().toLowerCase());

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((name) => (
        <Badge key={name} variant="secondary" className="gap-1 pr-1 font-normal">
          {name}
          <button
            type="button"
            className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
            onClick={() => onChange(value.filter((v) => v !== name))}
            aria-label={`Remove ${name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs">
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="A name at the firm, or type one" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>No one by that name. Press Add to type it in.</CommandEmpty>
              <CommandGroup heading="The firm">
                {options
                  .filter((o) => !chosen.has(o.toLowerCase()))
                  .map((o) => (
                    <CommandItem key={o} value={o} onSelect={() => add(o)}>
                      {o}
                    </CommandItem>
                  ))}
              </CommandGroup>
              {typedIsNew && (
                <CommandGroup heading="Typed in">
                  <CommandItem value={`add ${query}`} onSelect={() => add(query)}>
                    Add “{query.trim()}”
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
