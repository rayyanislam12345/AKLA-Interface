import { useState } from "react";
import { useProfiles, useSetUserRole, type AppRole } from "@/hooks/useProfiles";
import {
  useWhatsAppAccountLinks,
  useLinkWhatsAppAccount,
  useUnlinkWhatsAppAccount,
} from "@/hooks/useWhatsAppAccountLinks";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ROLES: AppRole[] = ["admin", "partner", "associate", "paralegal"];

function WhatsAppAccountsSection() {
  const { data: profiles } = useProfiles();
  const { data: links, isLoading } = useWhatsAppAccountLinks();
  const linkAccount = useLinkWhatsAppAccount();
  const unlinkAccount = useUnlinkWhatsAppAccount();
  const { toast } = useToast();

  const [whatsappUserId, setWhatsappUserId] = useState("");
  const [profileId, setProfileId] = useState("");

  const handleLink = async () => {
    if (!whatsappUserId.trim() || !profileId) return;
    try {
      await linkAccount.mutateAsync({ whatsappUserId: whatsappUserId.trim(), profileId });
      setWhatsappUserId("");
      setProfileId("");
      toast({ title: "WhatsApp account linked" });
    } catch (err: any) {
      toast({ title: "Failed to link account", description: err.message, variant: "destructive" });
    }
  };

  const handleUnlink = async (id: string) => {
    try {
      await unlinkAccount.mutateAsync(id);
      toast({ title: "WhatsApp account unlinked" });
    } catch (err: any) {
      toast({ title: "Failed to unlink account", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WhatsApp Accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Maps a lawyer's whatsapp-dashboard username to their AKLA Matter Hub account, so their tracked
          WhatsApp matters sync in under their own name.
        </p>

        <div className="flex gap-3 items-end flex-wrap">
          <div className="space-y-2">
            <label className="text-sm font-medium">Dashboard username</label>
            <Input
              value={whatsappUserId}
              onChange={(e) => setWhatsappUserId(e.target.value)}
              placeholder="e.g. testuser3"
              className="w-48"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Lawyer</label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger className="w-64">
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
          <Button onClick={handleLink} disabled={!whatsappUserId.trim() || !profileId || linkAccount.isPending}>
            Link
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !links?.length ? (
          <p className="text-sm text-muted-foreground">No WhatsApp accounts linked yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dashboard username</TableHead>
                <TableHead>Linked lawyer</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className="font-mono text-sm">{link.whatsapp_user_id}</TableCell>
                  <TableCell>{link.profile_name || link.profile_email}</TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" onClick={() => handleUnlink(link.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

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

      {isAdmin && <WhatsAppAccountsSection />}
    </div>
  );
}
