import { useState } from "react";
import { useProfiles, useSetUserRole, usePendingProfiles, useDecideProfileApproval, type AppRole } from "@/hooks/useProfiles";
import {
  useWhatsAppAccountLinks,
  useLinkWhatsAppAccount,
  useUnlinkWhatsAppAccount,
  type WhatsAppAccountLink,
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

const ROLES: AppRole[] = ["admin", "partner", "senior_counsel", "associate", "paralegal"];

// Senior Counsel is the one multi-word role — everything else already
// reads fine lowercase-raw, but "senior_counsel" needs the underscore
// turned into a space and each word capitalized.
function roleLabel(role: string) {
  return role
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// A firm's founder(s) get displayed as "Founder" instead of "Admin" — purely
// cosmetic. Their actual role in user_roles stays "admin" (that's what
// grants real permissions everywhere in the app), and the role-editing
// Select below stays driven by the real ROLES/AppRole enum, unchanged — this
// only touches how an existing admin's badge is labeled here. Only ever a
// couple of people, so a hardcoded list beats a schema change.
const FOUNDER_EMAILS: string[] = [];

function displayRoleLabel(profile: { role: string | null; email: string }) {
  if (profile.role === "admin" && FOUNDER_EMAILS.includes(profile.email)) return "Founder";
  return profile.role ? roleLabel(profile.role) : "no role";
}

function WhatsAppStatusBadge({ link }: { link: WhatsAppAccountLink | undefined }) {
  if (!link) {
    return (
      <Badge variant="outline" className="text-muted-foreground font-normal">
        Not linked
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      Linked · {link.whatsapp_user_id}
    </Badge>
  );
}

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
          <>
            <div className="hidden sm:block">
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
            </div>

            <div className="sm:hidden space-y-2">
              {links.map((link) => (
                <div key={link.id} className="flex items-center justify-between gap-2 border rounded-md px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm truncate">{link.whatsapp_user_id}</p>
                    <p className="text-sm text-muted-foreground truncate">{link.profile_name || link.profile_email}</p>
                  </div>
                  <Button size="icon" variant="ghost" className="shrink-0" onClick={() => handleUnlink(link.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PendingApprovalsSection() {
  const { data: pending, isLoading } = usePendingProfiles();
  const decide = useDecideProfileApproval();
  const { toast } = useToast();

  const handleDecide = async (userId: string, status: "approved" | "rejected") => {
    try {
      await decide.mutateAsync({ userId, status });
      toast({ title: status === "approved" ? "Account approved" : "Account rejected" });
    } catch (err: any) {
      toast({ title: "Failed to update account", description: err.message, variant: "destructive" });
    }
  };

  if (!isLoading && !pending?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending Approvals</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="w-48"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending?.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.full_name || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{p.email}</TableCell>
                      <TableCell>
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={decide.isPending}
                            onClick={() => handleDecide(p.id, "rejected")}
                          >
                            Reject
                          </Button>
                          <Button size="sm" disabled={decide.isPending} onClick={() => handleDecide(p.id, "approved")}>
                            Approve
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="sm:hidden space-y-2">
              {pending?.map((p) => (
                <div key={p.id} className="border rounded-md px-3 py-2.5 space-y-2">
                  <div className="min-w-0">
                    <p className="font-medium">{p.full_name || "—"}</p>
                    <p className="text-sm text-muted-foreground truncate">{p.email}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={decide.isPending}
                      onClick={() => handleDecide(p.id, "rejected")}
                    >
                      Reject
                    </Button>
                    <Button size="sm" disabled={decide.isPending} onClick={() => handleDecide(p.id, "approved")}>
                      Approve
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
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

  const { data: links } = useWhatsAppAccountLinks();
  const linkByProfileId = new Map(links?.map((link) => [link.profile_id, link]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-muted-foreground">Lawyers with access to the firm's matters.</p>
      </div>

      {isAdmin && <PendingApprovalsSection />}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  {isAdmin && <TableHead>WhatsApp</TableHead>}
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
                                {roleLabel(role)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary">{displayRoleLabel(profile)}</Badge>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <WhatsAppStatusBadge link={linkByProfileId.get(profile.id)} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {profiles?.map((profile) => (
              <div key={profile.id} className="border rounded-md px-3 py-2.5 space-y-2">
                <div className="min-w-0">
                  <p className="font-medium">{profile.full_name || "—"}</p>
                  <p className="text-sm text-muted-foreground truncate">{profile.email}</p>
                </div>
                {isAdmin ? (
                  <Select
                    value={profile.role ?? undefined}
                    onValueChange={(value) => setRole.mutate({ userId: profile.id, role: value as AppRole })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No role" />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {roleLabel(role)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">{displayRoleLabel(profile)}</Badge>
                )}
                {isAdmin && <WhatsAppStatusBadge link={linkByProfileId.get(profile.id)} />}
              </div>
            ))}
          </div>
        </>
      )}

      {isAdmin && <WhatsAppAccountsSection />}
    </div>
  );
}
