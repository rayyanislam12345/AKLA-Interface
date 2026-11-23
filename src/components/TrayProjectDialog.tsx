import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateProjectFromTray } from "@/hooks/useIntake";
import type { TrayItem } from "@/hooks/useTransactions";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { readTrayItem } from "@/lib/transactions";

function ProjectForm({ item, onClose }: { item: TrayItem; onClose: () => void }) {
  const v = readTrayItem(item);
  const draft = v.guessNewProject;
  const [name, setName] = useState(draft?.name || v.name || v.transaction);
  const [client, setClient] = useState(draft?.client ?? "");
  const [code, setCode] = useState(draft?.code || v.code);
  const create = useCreateProjectFromTray();
  const { toast } = useToast();

  const submit = async () => {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ item, name, client, code });
      toast({ title: "Project created", description: "Anything waiting for it will be filed within a few minutes." });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't create the project", description: friendlyError(e), variant: "destructive" });
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="tray-project-name">Project</Label>
        <Input id="tray-project-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="space-y-2">
          <Label htmlFor="tray-project-client">Client</Label>
          <Input id="tray-project-client" placeholder="An existing client, or a new one" value={client} onChange={(e) => setClient(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tray-project-code">Code</Label>
          <Input id="tray-project-code" placeholder="e.g. ADB" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create the project"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Create the project", from a Needs-a-look item: the name, client and code the Hub drafted, to check before it is made. */
export function TrayProjectDialog({ item, onClose }: { item: TrayItem | null; onClose: () => void }) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>It starts with the usual six stages. Change anything that is not right.</DialogDescription>
        </DialogHeader>
        {item && <ProjectForm key={item.id} item={item} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
