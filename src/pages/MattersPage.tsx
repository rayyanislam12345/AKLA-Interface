import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { useMatters, useCreateMatter } from "@/hooks/useMatters";
import { useClients } from "@/hooks/useClients";
import { useProfiles } from "@/hooks/useProfiles";
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
  const createMatter = useCreateMatter();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [sector, setSector] = useState("");
  const [leadPartnerId, setLeadPartnerId] = useState<string>("");

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
      toast({ title: "Matter created" });
      setOpen(false);
      setName("");
      setClientId("");
      setSector("");
      setLeadPartnerId("");
    } catch (e: any) {
      toast({ title: "Failed to create matter", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Matters</h1>
          <p className="text-muted-foreground">Transactions and engagements the firm is working on.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Matter
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Matter</DialogTitle>
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
                <Label>Lead Partner</Label>
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
        <p className="text-muted-foreground">No matters yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead>Lead Partner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Target Close</TableHead>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
