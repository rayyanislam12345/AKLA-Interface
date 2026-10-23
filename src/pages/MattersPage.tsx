import { friendlyError } from "@/lib/friendlyError";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Pencil, Search, X } from "lucide-react";
import {
  useMatters,
  useCreateMatter,
  useUpdateMatter,
  normalizeMatterStatus,
  matterStatusLabel,
  matterStatusBadgeVariant,
  MATTER_STATUSES,
  MATTER_STATUS_LABELS,
  type MatterStatus,
} from "@/hooks/useMatters";
import { useClients, useCreateClient } from "@/hooks/useClients";
import { useProfiles } from "@/hooks/useProfiles";
import { useAuth } from "@/hooks/useAuth";
import { LoadState } from "@/components/LoadState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

function errorText(e: unknown) {
  return e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "Please try again.";
}

// Stored as yyyy-mm-dd; shown in the reader's own date format.
function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

export interface EditableProject {
  id: string;
  name: string;
  client_id: string | null;
  sector: string | null;
  lead_partner_id: string | null;
  status: string;
  target_close_date: string | null;
}

/**
 * Edit a project's details. Open to every firm member: row-level security
 * already lets any member update a project, and the person who mistyped a
 * name or forgot the client is usually not an admin. Used from the Projects
 * list and from the project's own page. Pass the project to open, null to close.
 */
export function EditProjectDialog({ matter, onClose }: { matter: EditableProject | null; onClose: () => void }) {
  const { data: clients } = useClients();
  const { data: profiles } = useProfiles();
  const updateMatter = useUpdateMatter();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [sector, setSector] = useState("");
  const [leadPartnerId, setLeadPartnerId] = useState("");
  const [status, setStatus] = useState<MatterStatus>("active");
  const [targetClose, setTargetClose] = useState("");

  // Seeded when the dialog opens for a project, not on every refetch, so a
  // background refresh never wipes what is being typed.
  const openId = matter?.id ?? null;
  useEffect(() => {
    if (!matter) return;
    setName(matter.name);
    setClientId(matter.client_id || "");
    setSector(matter.sector || "");
    setLeadPartnerId(matter.lead_partner_id || "");
    setStatus(normalizeMatterStatus(matter.status));
    setTargetClose(matter.target_close_date || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const handleSave = async () => {
    if (!matter || !name.trim()) return;
    try {
      await updateMatter.mutateAsync({
        id: matter.id,
        name: name.trim(),
        client_id: clientId || undefined,
        sector: sector.trim() || undefined,
        lead_partner_id: leadPartnerId || undefined,
        status,
        target_close_date: targetClose || null,
      });
      toast({ title: "Project updated" });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save the project", description: friendlyError(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={!!matter} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-matter-name">Name</Label>
            <Input id="edit-matter-name" value={name} onChange={(e) => setName(e.target.value)} />
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
            <Label htmlFor="edit-matter-sector">Sector</Label>
            <Input
              id="edit-matter-sector"
              placeholder="e.g. Power, Roads, Water"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Project Lead</Label>
            <Select value={leadPartnerId} onValueChange={setLeadPartnerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a lead" />
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as MatterStatus)}>
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MATTER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {MATTER_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-matter-target-close">Target close date</Label>
              <Input
                id="edit-matter-target-close"
                type="date"
                value={targetClose}
                onChange={(e) => setTargetClose(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || updateMatter.isPending}>
              {updateMatter.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type StatusFilter = "any" | MatterStatus;

export default function MattersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const clientFilter = searchParams.get("client");
  // Closed projects are loaded too, but hidden until "Show closed" is on.
  const { data: matters, isLoading, error, refetch } = useMatters();
  const { data: clients } = useClients();
  const { data: profiles } = useProfiles();
  const createMatter = useCreateMatter();
  const createClient = useCreateClient();
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  // The client is typed: an existing client by name, or a new one created
  // with the project.
  const [clientName, setClientName] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [sector, setSector] = useState("");
  const [leadPartnerId, setLeadPartnerId] = useState<string>("");
  const [targetClose, setTargetClose] = useState("");

  const [editMatter, setEditMatter] = useState<EditableProject | null>(null);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("any");
  const [showClosed, setShowClosed] = useState(false);

  const filterClientName = clientFilter ? clients?.find((c) => c.id === clientFilter)?.name ?? "this client" : null;

  const clearClientFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("client");
    setSearchParams(next, { replace: true });
  };

  // Everything but the closed toggle, so the empty state can say when
  // matching projects are only hidden because they are closed.
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (matters ?? []).filter((m) => {
      if (clientFilter && m.client_id !== clientFilter) return false;
      if (statusFilter !== "any" && normalizeMatterStatus(m.status) !== statusFilter) return false;
      if (!q) return true;
      return [m.name, m.client?.name, m.sector, m.lead_partner?.full_name]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q));
    });
  }, [matters, clientFilter, statusFilter, query]);

  const closedVisible = showClosed || statusFilter === "closed";
  const visibleMatters = closedVisible ? matching : matching.filter((m) => normalizeMatterStatus(m.status) !== "closed");
  const hiddenClosedCount = matching.length - visibleMatters.length;
  const isFiltered = !!query.trim() || statusFilter !== "any";

  const openNewProject = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    // Arriving from a client: the new project is most likely for them.
    if (clientFilter && !clientName) setClientName(clients?.find((c) => c.id === clientFilter)?.name ?? "");
    // The person creating it leads it unless they say otherwise.
    if (!leadPartnerId && user?.id) setLeadPartnerId(user.id);
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      const typed = clientName.trim();
      let clientId = typed ? clients?.find((c) => c.name.trim().toLowerCase() === typed.toLowerCase())?.id : undefined;
      if (typed && !clientId) clientId = (await createClient.mutateAsync({ name: typed })).id;
      const created = await createMatter.mutateAsync({
        name: name.trim(),
        client_id: clientId || undefined,
        sector: sector.trim() || undefined,
        lead_partner_id: leadPartnerId || undefined,
        target_close_date: targetClose || undefined,
      });
      toast({ title: "Project created", description: "Add its documents with Upload files, or drag them onto the Documents card." });
      setOpen(false);
      setName("");
      setClientName("");
      setSector("");
      setLeadPartnerId("");
      setTargetClose("");
      setShowMore(false);
      if (created?.id) navigate(`/matters/${created.id}`);
    } catch (e) {
      toast({ title: "Couldn't create the project", description: friendlyError(e), variant: "destructive" });
    }
  };

  const openEdit = (matter: EditableProject, e: React.MouseEvent) => {
    e.stopPropagation(); // the row/card itself navigates to the matter on click
    setEditMatter(matter);
  };

  const emptyState = (() => {
    if (!matters?.length) {
      return (
        <div className="space-y-2 text-muted-foreground">
          <p>No projects yet.</p>
          <Button size="sm" onClick={() => openNewProject(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create the first project
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-2 text-muted-foreground">
        <p>
          {isFiltered
            ? "No projects match your search."
            : filterClientName
              ? `No open projects for ${filterClientName} yet.`
              : "No open projects."}
        </p>
        {hiddenClosedCount > 0 && (
          <p className="text-sm">
            {hiddenClosedCount} closed project{hiddenClosedCount === 1 ? "" : "s"} match.{" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setShowClosed(true)}>
              Show closed projects
            </button>
          </p>
        )}
        {filterClientName && !isFiltered && (
          <Button size="sm" variant="outline" onClick={() => openNewProject(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project for {filterClientName}
          </Button>
        )}
      </div>
    );
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-muted-foreground">
            Transactions and engagements the firm is working on.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => navigate("/clients")}>Clients</button>
          </p>
        </div>
        <Dialog open={open} onOpenChange={openNewProject}>
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
                <Label htmlFor="matter-client">Client (optional)</Label>
                <Input
                  id="matter-client"
                  list="matter-client-names"
                  placeholder="Type a client's name"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                />
                <datalist id="matter-client-names">
                  {clients?.map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
                {clientName.trim() && !clients?.some((c) => c.name.trim().toLowerCase() === clientName.trim().toLowerCase()) && (
                  <p className="text-xs text-muted-foreground">A new client, “{clientName.trim()}”, is added with the project.</p>
                )}
              </div>
              {!showMore ? (
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowMore(true)}>
                  More details: sector, project lead, target close date
                </button>
              ) : (
              <>
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
                    <SelectValue placeholder="Select a lead" />
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
                <Label htmlFor="matter-target-close">Target close date (optional)</Label>
                <Input
                  id="matter-target-close"
                  type="date"
                  value={targetClose}
                  onChange={(e) => setTargetClose(e.target.value)}
                />
              </div>
              </>
              )}
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={!name.trim() || createMatter.isPending || createClient.isPending}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, client, sector or lead"
            aria-label="Search projects"
            className="pl-8"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v as StatusFilter);
            if (v === "closed") setShowClosed(true);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            {MATTER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {MATTER_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={closedVisible}
            onCheckedChange={(checked) => {
              setShowClosed(checked);
              if (!checked && statusFilter === "closed") setStatusFilter("any");
            }}
            aria-label="Show closed projects"
          />
          Show closed
        </label>
        {filterClientName && (
          <Badge variant="secondary" className="gap-1 pr-1 text-sm font-normal">
            Client: {filterClientName}
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
              onClick={clearClientFilter}
              aria-label={`Stop filtering by ${filterClientName}`}
              title="Show all clients"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Badge>
        )}
      </div>

      <LoadState
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        what="projects"
        isEmpty={!visibleMatters.length}
        empty={emptyState}
      >
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
                  <TableHead className="w-12" />
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
                      <Badge variant={matterStatusBadgeVariant(matter.status)}>{matterStatusLabel(matter.status)}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(matter.target_close_date)}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit project"
                        aria-label={`Edit ${matter.name}`}
                        onClick={(e) => openEdit(matter, e)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
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
                    <Badge variant={matterStatusBadgeVariant(matter.status)}>{matterStatusLabel(matter.status)}</Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Edit ${matter.name}`}
                      onClick={(e) => openEdit(matter, e)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {[matter.client?.name, matter.sector, matter.lead_partner?.full_name].filter(Boolean).join(" · ") || "—"}
                </p>
                {matter.target_close_date && (
                  <p className="text-xs text-muted-foreground mt-1">Target close: {formatDate(matter.target_close_date)}</p>
                )}
              </div>
            ))}
          </div>
      </LoadState>

      <EditProjectDialog matter={editMatter} onClose={() => setEditMatter(null)} />
    </div>
  );
}
