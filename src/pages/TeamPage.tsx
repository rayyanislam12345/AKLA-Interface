import { useProfiles, useSetUserRole, type AppRole } from "@/hooks/useProfiles";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ROLES: AppRole[] = ["admin", "partner", "associate", "paralegal"];

export default function TeamPage() {
  const { user } = useAuth();
  const { data: profiles, isLoading } = useProfiles();
  const setRole = useSetUserRole();

  const currentUser = profiles?.find((p) => p.id === user?.id);
  const isAdmin = currentUser?.role === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-muted-foreground">Lawyers with access to the firm's matters.</p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles?.map((profile) => (
              <TableRow key={profile.id}>
                <TableCell className="font-medium">{profile.full_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{profile.email}</TableCell>
                <TableCell>
                  {isAdmin ? (
                    <Select
                      value={profile.role ?? undefined}
                      onValueChange={(value) => setRole.mutate({ userId: profile.id, role: value as AppRole })}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="No role" />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary">{profile.role || "no role"}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
