import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Pencil } from "lucide-react";
import { useMatters, useCreateMatter, useUpdateMatter, type MatterListItem } from "@/hooks/useMatters";
import { useClients } from "@/hooks/useClients";
import { useProfiles } from "@/hooks/useProfiles";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

export default function MattersPage() {
  const [searchParams] = useSearchParams();
  const clientFilter = searchParams.get("client");
  const { data: matters, isLoading } = useMatters();
  const { data: clients } = useClients();
  const { data: profiles } = useProfiles();
  const { user } = useAuth();
  const createMatter = useCreateMatter();
  const updateMatter = useUpdateMatter();
  const { toast } = useToast();
  const navigate = useNavigate();

  const isAdmin = profiles?.find((p) => p.id === user?.id)?.role === "admin";

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [sector, setSector] = useState("");
  const [leadPartnerId, setLeadPartnerId] = useState<string>("");

  const [editMatter, setEditMatter] = useState<MatterListItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editClientId, setEditClientId] = useState<string>("");
  const [editSector, setEditSector] = useState("");
  const [editLeadPartnerId, setEditLeadPartnerId] = useState<string>("");
  const [editStatus, setEditStatus] = useState("");

  const visibleMatters = clientFilter
    ? matters?.filter((m) => m.client_id === clientFilter)
    : matters;

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      await createMatter.mutateAsync({
        name: name.trim(),
        client_id: clientId || undefined,
        sector: sector.trim() || undefined,
        lead_partner_id: leadPartnerId || undefined,
      });
      toast({ title: "Project created" });
      setOpen(false);
      setName("");
      setClientId("");
      setSector("");
      setLeadPartnerId("");
    } catch (e: any) {
      toast({ title: "Failed to create project", description: e.message, variant: "destructive" });
    }
  };

  const openEdit = (matter: MatterListItem, e: React.MouseEvent) => {
    e.stopPropagation(); // the row/card itself navigates to the matter on click
    setEditMatter(matter);
    setEditName(matter.name);
    setEditClientId(matter.client_id || "");
    setEditSector(matter.sector || "");
    setEditLeadPartnerId(matter.lead_partner_id || "");
    setEditStatus(matter.status);
  };

  const handleUpdate = async () => {
    if (!editMatter || !editName.trim() || !editStatus.trim()) return;
    try {
      await updateMatter.mutateAsync({
        id: editMatter.id,
        name: editName.trim(),
        client_id: editClientId || undefined,
        sector: editSector.trim() || undefined,
        lead_partner_id: editLeadPartnerId || undefined,
        status: editStatus.trim(),
      });
      toast({ title: "Project updated" });
      setEditMatter(null);
    } catch (e: any) {
      toast({ title: "Failed to update project", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-muted-foreground">Transactions and engagements the firm is working on.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Project</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="matter-name">Name</Label>
                <Input id="matter-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Client</Label>
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="matter-sector">Sector</Label>
                <Input
                  id="matter-sector"
                  placeholder="e.g. Power, Roads, Water"
                  value={sector}
                  onChange={(e) => setSector(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Project Lead</Label>
                <Select value={leadPartnerId} onValueChange={setLeadPartnerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a lawyer" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.full_name || p.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={!name.trim() || createMatter.isPending}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !visibleMatters?.length ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <>
          {/* A table's columns can't shrink enough to fit a phone without
              horizontal scroll — a stacked card per matter needs none. */}
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Sector</TableHead>
                  <TableHead>Project Lead</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Target Close</TableHead>
                  {isAdmin && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMatters.map((matter) => (
                  <TableRow
                    key={matter.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/matters/${matter.id}`)}
                  >
                    <TableCell className="font-medium">{matter.name}</TableCell>
                    <TableCell>{matter.client?.name || "—"}</TableCell>
                    <TableCell>{matter.sector || "—"}</TableCell>
                    <TableCell>{matter.lead_partner?.full_name || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={matter.status === "active" ? "default" : "secondary"}>
                        {matter.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{matter.target_close_date || "—"}</TableCell>
                    {isAdmin && (
                      <TableCell>
                        <Button size="icon" variant="ghost" onClick={(e) => openEdit(matter, e)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {visibleMatters.map((matter) => (
              <div
                key={matter.id}
                className="w-full text-left border rounded-md px-3 py-2.5 cursor-pointer"
                onClick={() => navigate(`/matters/${matter.id}`)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{matter.name}</p>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant={matter.status === "active" ? "default" : "secondary"}>
                      {matter.status}
                    </Badge>
                    {isAdmin && (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={(e) => openEdit(matter, e)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {[matter.client?.name, matter.sector, matter.lead_partner?.full_name].filter(Boolean).join(" · ") || "—"}
                </p>
                {matter.target_close_date && (
                  <p className="text-xs text-muted-foreground mt-1">Target close: {matter.target_close_date}</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {isAdmin && (
        <Dialog open={!!editMatter} onOpenChange={(open) => !open && setEditMatter(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Project</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="edit-matter-name">Name</Label>
                <Input id="edit-matter-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Client</Label>
                <Select value={editClientId} onValueChange={setEditClientId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-matter-sector">Sector</Label>
                <Input
                  id="edit-matter-sector"
                  placeholder="e.g. Power, Roads, Water"
                  value={editSector}
                  onChange={(e) => setEditSector(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Project Lead</Label>
                <Select value={editLeadPartnerId} onValueChange={setEditLeadPartnerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a lawyer" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.full_name || p.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-matter-status">Status</Label>
                <Input
                  id="edit-matter-status"
                  placeholder="e.g. active, on hold, closed"
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleUpdate} disabled={!editName.trim() || !editStatus.trim() || updateMatter.isPending}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
