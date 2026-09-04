import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useMatters } from "@/hooks/useMatters";
import LegalUpdatesCard from "@/components/dashboard/LegalUpdatesCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Dashboard() {
  const { user } = useAuth();
  const { data: matters, isLoading } = useMatters();
  const navigate = useNavigate();

  const active = matters?.filter((m) => m.status === "active") ?? [];
  const other = matters?.filter((m) => m.status !== "active") ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome{user?.email ? `, ${user.email}` : ""}</h1>
        <p className="text-muted-foreground">Firm-wide view of every active matter.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">Active Matters</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{active.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">Other</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{other.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground font-normal">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{matters?.length ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      <LegalUpdatesCard />

      <div>
        <h2 className="text-lg font-medium mb-3">Matters</h2>
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !matters?.length ? (
          <p className="text-muted-foreground">
            No matters yet — head to the Matters page to create the first one.
          </p>
        ) : (
          <>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Lead Partner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Target Close</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matters.map((matter) => (
                    <TableRow
                      key={matter.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/matters/${matter.id}`)}
                    >
                      <TableCell className="font-medium">{matter.name}</TableCell>
                      <TableCell>{matter.client?.name || "—"}</TableCell>
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
            </div>

            <div className="sm:hidden space-y-2">
              {matters.map((matter) => (
                <button
                  key={matter.id}
                  className="w-full text-left border rounded-md px-3 py-2.5"
                  onClick={() => navigate(`/matters/${matter.id}`)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{matter.name}</p>
                    <Badge variant={matter.status === "active" ? "default" : "secondary"} className="shrink-0">
                      {matter.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {[matter.client?.name, matter.lead_partner?.full_name].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {matter.target_close_date && (
                    <p className="text-xs text-muted-foreground mt-1">Target close: {matter.target_close_date}</p>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
