import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useMatters, normalizeMatterStatus, matterStatusLabel, matterStatusBadgeVariant } from "@/hooks/useMatters";
import { LoadState } from "@/components/LoadState";
import LegalUpdatesCard from "@/components/dashboard/LegalUpdatesCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Stored as yyyy-mm-dd; shown in the reader's own date format.
function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data: myProfile } = useMyProfile();
  // Open projects only (Active and On hold); closed ones live on the Projects page.
  const { data: matters, isLoading, error, refetch } = useMatters({ openOnly: true });
  const navigate = useNavigate();

  const active = matters?.filter((m) => normalizeMatterStatus(m.status) === "active") ?? [];
  const onHold = matters?.filter((m) => normalizeMatterStatus(m.status) === "on_hold") ?? [];
  const greetingName = myProfile?.full_name?.trim() || user?.email || "";
  const count = (n: number) => (isLoading || error ? "—" : n);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome{greetingName ? `, ${greetingName}` : ""}</h1>
        <p className="text-muted-foreground">Firm-wide view of every open project.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">Active</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{count(active.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">On hold</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{count(onHold.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">Open projects</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{count(matters?.length ?? 0)}</p>
          </CardContent>
        </Card>
      </div>

      <LegalUpdatesCard />

      <div>
        <h2 className="text-lg font-medium mb-3">Projects</h2>
        <LoadState
          isLoading={isLoading}
          error={error}
          onRetry={() => refetch()}
          what="projects"
          isEmpty={!matters?.length}
          empty="No open projects. Head to the Projects page to create one, or to see closed ones."
        >
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Project Lead</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Target Close</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(matters ?? []).map((matter) => (
                    <TableRow
                      key={matter.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/matters/${matter.id}`)}
                    >
                      <TableCell className="font-medium">{matter.name}</TableCell>
                      <TableCell>{matter.client?.name || "—"}</TableCell>
                      <TableCell>{matter.lead_partner?.full_name || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={matterStatusBadgeVariant(matter.status)}>
                          {matterStatusLabel(matter.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDate(matter.target_close_date)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="sm:hidden space-y-2">
              {(matters ?? []).map((matter) => (
                <button
                  key={matter.id}
                  className="w-full text-left border rounded-md px-3 py-2.5"
                  onClick={() => navigate(`/matters/${matter.id}`)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{matter.name}</p>
                    <Badge variant={matterStatusBadgeVariant(matter.status)} className="shrink-0">
                      {matterStatusLabel(matter.status)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {[matter.client?.name, matter.lead_partner?.full_name].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {matter.target_close_date && (
                    <p className="text-xs text-muted-foreground mt-1">Target close: {formatDate(matter.target_close_date)}</p>
                  )}
                </button>
              ))}
            </div>
        </LoadState>
      </div>
    </div>
  );
}
