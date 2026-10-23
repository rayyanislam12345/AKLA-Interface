import { friendlyError } from "@/lib/friendlyError";
import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@supabase/supabase-js";
import { KeyRound, Loader2, LogOut, Shield, User } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useToast } from "@/hooks/use-toast";
import { MFAEnrollment } from "@/components/MFAEnrollment";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// The same minimum the sign-up, invite and reset-password screens use.
const PASSWORD_MIN_LENGTH = 8;

/**
 * Checks a password without touching the signed-in session. Signing in again
 * on the app's own client would replace the current session with a fresh
 * one-step (password only) session, which for someone with two-step sign-in
 * would immediately ask for their authenticator code again and block the
 * password change. A throwaway client that keeps nothing in storage avoids
 * that; its own session is then ended on the server.
 */
async function isCurrentPassword(email: string, password: string): Promise<boolean> {
  const checker = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "akla-password-check",
    },
  });
  const { data, error } = await checker.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  // "local" ends only this throwaway session; the default would sign the
  // person out everywhere.
  await checker.auth.signOut({ scope: "local" });
  return true;
}

function plainAuthError(message: string): string {
  if (/should be different/i.test(message)) return "The new password must be different from your current one.";
  if (/aal2/i.test(message)) return "Enter your authenticator code first: sign out, sign in again and type the code.";
  if (/weak|pwned|characters/i.test(message)) return `That password is too easy to guess. ${message}`;
  return message;
}

function NameCard() {
  const { user } = useAuth();
  const { data: profile, isLoading } = useMyProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile) setFullName(profile.full_name ?? "");
  }, [profile]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const name = fullName.trim();
    if (!name) {
      toast({ title: "Enter your name", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
    setSaving(false);
    if (error) {
      toast({ title: "Your name was not saved", description: friendlyError(error), variant: "destructive" });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["my-profile"] });
    queryClient.invalidateQueries({ queryKey: ["profiles"] });
    toast({ title: "Name saved", description: "This is the name colleagues see and the one printed on your timesheet." });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" />
          Your name
        </CardTitle>
        <CardDescription>Shown to colleagues on the Team page and printed on your timesheet.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-email">Email</Label>
            <Input id="settings-email" value={profile?.email ?? user?.email ?? ""} readOnly disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-name">Full name</Label>
            <Input
              id="settings-name"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={isLoading || saving}
            />
          </div>
          <Button type="submit" disabled={isLoading || saving || fullName.trim() === (profile?.full_name ?? "")}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save name
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!user?.email) return;
    if (next.length < PASSWORD_MIN_LENGTH) {
      setProblem(`The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setProblem("The two new passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      if (!(await isCurrentPassword(user.email, current))) {
        setProblem("Your current password is not right.");
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) {
        setProblem(plainAuthError(error.message));
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      toast({ title: "Password changed", description: "Use the new password next time you sign in." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          Change password
        </CardTitle>
        <CardDescription>
          Type your current password, then the new one twice. At least {PASSWORD_MIN_LENGTH} characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {/* Lets password managers file the new password under the right account. */}
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={user?.email ?? ""}
            readOnly
            hidden
          />
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-new-password">Confirm new password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              disabled={saving}
            />
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
          <Button type="submit" disabled={saving || !current || !next || !confirm}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoStepCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: factors, isLoading, error } = useQuery({
    queryKey: ["mfa-factors", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      return data;
    },
  });
  const verified = factors?.totp?.[0] ?? null;

  const refresh = async () => {
    // Pick up the changed factor list in the session too, which is what the
    // sign-in check on every page reads.
    await supabase.auth.refreshSession();
    await queryClient.invalidateQueries({ queryKey: ["mfa-factors"] });
  };

  const startEnrolment = async () => {
    setBusy(true);
    // A set-up that was abandoned half way leaves an unconfirmed factor
    // behind, and a new one with the same name would be refused. Clear those
    // first; they never protected anything.
    const unconfirmed = (factors?.all ?? []).filter((f) => f.factor_type === "totp" && f.status !== "verified");
    for (const f of unconfirmed) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    setBusy(false);
    setEnrolOpen(true);
  };

  const remove = async () => {
    if (!verified) return;
    setConfirmRemove(false);
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: verified.id });
    if (error) {
      setBusy(false);
      toast({ title: "Two-step sign-in was not turned off", description: friendlyError(error), variant: "destructive" });
      return;
    }
    await refresh();
    setBusy(false);
    toast({ title: "Two-step sign-in is off", description: "You will only need your password to sign in." });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Two-step sign-in
          {verified && <Badge variant="secondary">On</Badge>}
        </CardTitle>
        <CardDescription>
          Also called two-factor authentication. When it is on, signing in needs your password and a 6-digit code from
          an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy or 1Password).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not check two-step sign-in: {(error as Error).message}</p>
        ) : verified ? (
          <>
            <p className="text-sm">
              On since {new Date(verified.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.
            </p>
            <Button variant="outline" onClick={() => setConfirmRemove(true)} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Turn off two-step sign-in
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Off. Only your password is needed to sign in.</p>
            <Button onClick={startEnrolment} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Turn on two-step sign-in
            </Button>
          </>
        )}
      </CardContent>

      <MFAEnrollment
        open={enrolOpen}
        onOpenChange={setEnrolOpen}
        onSuccess={() => {
          void refresh();
        }}
      />

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-step sign-in?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone who learns your password will be able to sign in as you. You can turn it back on at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Turn it off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function SignOutEverywhereCard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const signOutEverywhere = async () => {
    setConfirm(false);
    setBusy(true);
    const { error } = await supabase.auth.signOut({ scope: "global" });
    setBusy(false);
    if (error) {
      toast({ title: "Could not sign out everywhere", description: friendlyError(error), variant: "destructive" });
      return;
    }
    queryClient.clear();
    navigate("/auth", { replace: true });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <LogOut className="h-4 w-4" />
          Sign out of all devices
        </CardTitle>
        <CardDescription>
          Signs you out here and on every other computer, phone or browser where you are signed in, for example an
          office laptop you shared. You will need your password (and code, if two-step sign-in is on) to come back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => setConfirm(true)} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Sign out of all devices
        </Button>
      </CardContent>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of all devices?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be signed out here too. Anything not yet saved on other devices may be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={signOutEverywhere}>Sign out everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Your name, password and sign-in security.</p>
      </div>
      <NameCard />
      <PasswordCard />
      <TwoStepCard />
      <SignOutEverywhereCard />
      <OtherPagesCard />
    </div>
  );
}

// Pages that left the sidebar stay one click away here.
const OTHER_PAGES = [
  { to: "/clients", label: "Clients", note: "the clients projects are attached to" },
  { to: "/dashboard", label: "Firm overview", note: "project counts by status" },
  { to: "/whatsapp-activity", label: "WhatsApp Activity", note: "documents picked up from a linked WhatsApp account" },
  { to: "/team", label: "Team", note: "everyone at the firm" },
  { to: "/document-types", label: "Document types", note: "the firm's list of kinds of document" },
  { to: "/assistant", label: "The Hub's own assistant", note: "being retired in favour of Claude" },
];

function OtherPagesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Other pages</CardTitle>
        <CardDescription>Less-used pages that are not in the sidebar.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm">
          {OTHER_PAGES.map((p) => (
            <li key={p.to}>
              <Link to={p.to} className="font-medium underline underline-offset-2">
                {p.label}
              </Link>
              <span className="text-muted-foreground"> — {p.note}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
