import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { isOpenMatter, type MatterListItem } from "@/hooks/useMatters";

interface ProjectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: MatterListItem[];
  onPick: (project: MatterListItem) => void;
  title?: string;
}

/** "Pick project…": a searchable list of the Hub's projects. */
export function ProjectPicker({ open, onOpenChange, projects, onPick, title = "Which project is it?" }: ProjectPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 sm:max-w-lg">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Search by project or client.</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search projects" />
          <CommandList className="max-h-80">
            <CommandEmpty>No project matches.</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.client?.name ?? ""}`}
                  onSelect={() => {
                    onPick(project);
                    onOpenChange(false);
                  }}
                  className="flex items-start justify-between gap-3"
                >
                  <span>
                    <span className="font-medium">{project.name}</span>
                    {project.client?.name && <span className="block text-xs text-muted-foreground">{project.client.name}</span>}
                  </span>
                  {!isOpenMatter(project) && <span className="shrink-0 text-xs text-muted-foreground">Closed</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
