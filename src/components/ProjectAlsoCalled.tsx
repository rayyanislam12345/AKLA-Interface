import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAddProjectName, useProjectNames, useRemoveProjectName } from "@/hooks/useIntake";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { nameKey } from "@/lib/intake";

interface ProjectAlsoCalledProps {
  matterId: string;
  projectName: string;
  /** The firm's short code for the transaction, when it has one. */
  code?: string | null;
}

/**
 * The other names a project goes by, as one muted line under its heading:
 * the firm's code and "Also called M6, Hyderabad Sukkur Motorway". Edit opens
 * the names to remove one or add another; whatever arrives under any of them
 * is placed on this project.
 */
export function ProjectAlsoCalled({ matterId, projectName, code }: ProjectAlsoCalledProps) {
  const { data: names } = useProjectNames(matterId);
  const add = useAddProjectName();
  const remove = useRemoveProjectName();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");

  const own = nameKey(projectName);
  // The project's own name, kept as a name too, is not "another" name.
  const chips = (names ?? []).filter((n) => n.kind !== "contains" && (n.name_key ?? nameKey(n.name)) !== own);
  const rules = (names ?? []).filter((n) => n.kind === "contains");
  const shown = chips.slice(0, 4).map((n) => n.name);
  const more = chips.length - shown.length;

  const submit = async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      await add.mutateAsync({ matterId, name });
      setDraft("");
    } catch (e) {
      toast({ title: "Couldn't add the name", description: friendlyError(e), variant: "destructive" });
    }
  };

  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {code && <span>Code {code}</span>}
      {code && chips.length > 0 && <span aria-hidden>·</span>}
      {chips.length > 0 && (
        <span className="min-w-0 break-words">
          Also called {shown.join(", ")}
          {more > 0 ? ` and ${more} more` : ""}
        </span>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="underline underline-offset-2 hover:text-foreground">
            {chips.length || rules.length ? "Edit" : "Add another name"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Also called</p>
            <p className="text-xs text-muted-foreground">A document, agenda line or email that uses one of these names is placed on this project.</p>
          </div>
          {code && (
            <p className="text-xs text-muted-foreground">
              Code <span className="text-foreground">{code}</span>
            </p>
          )}
          {chips.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {chips.map((n) => (
                <li key={n.id} className="inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-xs">
                  <span className="break-all">{n.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${n.name}`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(
                        { id: n.id, matterId },
                        { onError: (e) => toast({ title: "Couldn't remove the name", description: friendlyError(e), variant: "destructive" }) },
                      )
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rules.length > 0 && (
            <p className="text-xs text-muted-foreground">Deliverables containing {rules.map((r) => `"${r.name}"`).join(", ")} go here.</p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a name" aria-label="Add a name" className="h-8" />
            <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!draft.trim() || add.isPending}>
              Add
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
