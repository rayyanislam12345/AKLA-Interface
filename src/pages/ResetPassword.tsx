import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { MFAVerification } from "@/components/MFAVerification";
import type { Session } from "@supabase/supabase-js";

/** The authenticator factor a recovery session must be verified with before
 * Supabase allows a password change (accounts with two-step sign-in). */
async function factorNeedingCode(session: Session | null): Promise<string | null> {
  const factor = session?.user.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
  if (!factor) return null;
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel === "aal2" ? null : factor.id;
}

function parseHashParams(hash: string) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw);
}

// The same minimum the sign-up and invite screens use.
const PASSWORD_MIN_LENGTH = 8;

const EXPIRED_LINK = "This reset link has expired. Request a new one.";
const NO_LINK = "This page only works from the link in a password reset email. Request a new one.";

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the link itself can't be used (expired, already used, or the
  // page was opened without one): the form is replaced by a way to get a
  // fresh link.
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const params = useMemo(() => {
    const search = new URLSearchParams(window.location.search);
    const hash = parseHashParams(window.location.hash);
    return { search, hash };
  }, []);

  useEffect(() => {
    const hydrateSession = async () => {
      setError(null);

      try {
        // An expired or already-used link arrives as
        // #error=access_denied&error_code=otp_expired&error_description=...
        // (or the same in the query string for the code flow).
        const linkError =
          params.hash.get("error_code") ??
          params.hash.get("error") ??
          params.search.get("error_code") ??
          params.search.get("error");
        if (linkError) {
          setLinkProblem(EXPIRED_LINK);
          return;
        }

        const access_token = params.hash.get("access_token") ?? params.search.get("access_token");
        const refresh_token = params.hash.get("refresh_token") ?? params.search.get("refresh_token");
        const code = params.search.get("code");

        // Most Supabase recovery links arrive as #access_token=...&refresh_token=...
        if (access_token && refresh_token) {
          const { data, error } = await supabase.auth.setSession({
            access_token,
            refresh_token,
          });
          if (error) {
            setLinkProblem(EXPIRED_LINK);
            return;
          }
          setEmail(data.user?.email ?? "");
          setMfaFactorId(await factorNeedingCode(data.session));
          setReady(true);
          return;
        }

        // Some flows can arrive as ?code=... (PKCE)
        if (code && "exchangeCodeForSession" in supabase.auth) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            setLinkProblem(EXPIRED_LINK);
            return;
          }
          setEmail(data.user?.email ?? "");
          setMfaFactorId(await factorNeedingCode(data.session));
          setReady(true);
          return;
        }

        setLinkProblem(NO_LINK);
      } catch {
        setLinkProblem(EXPIRED_LINK);
      }
    };

    hydrateSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!ready) {
      setError("Reset link is not ready yet. Please refresh and try again.");
      return;
    }

    if (!password || password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      toast({
        title: "Password updated",
        description: "You can now sign in with your new password.",
      });

      // End recovery flow session and send them to login
      await supabase.auth.signOut();
      navigate("/auth", { replace: true });
    } catch (e) {
      const message = (e as Error)?.message ?? "Failed to update password.";
      setError(
        /should be different/i.test(message)
          ? "The new password must be different from your old one."
          : /aal2/i.test(message)
            ? "Enter the code from your authenticator app first: reload this page from the email link and type the code when asked."
            : message
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
      <div className="w-full max-w-md">
        <Card className="w-full border-border/50 shadow-elegant">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Reset password</CardTitle>
            <CardDescription className="text-center">
              Set a new password for your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {linkProblem ? (
              <div className="space-y-4">
                <Alert variant="destructive">
                  <AlertDescription>{linkProblem}</AlertDescription>
                </Alert>
                <Button
                  type="button"
                  className="w-full"
                  variant="premium"
                  onClick={() => navigate("/auth?step=forgot", { replace: true })}
                >
                  Request a new reset link
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => navigate("/auth", { replace: true })}
                >
                  Back to sign in
                </Button>
              </div>
            ) : mfaFactorId ? (
              <MFAVerification
                factorId={mfaFactorId}
                onSuccess={() => setMfaFactorId(null)}
                onCancel={async () => {
                  await supabase.auth.signOut();
                  navigate("/auth", { replace: true });
                }}
              />
            ) : (
            <>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={onSubmit} className="space-y-4">
              {/* Lets password managers save the new password against the right account. */}
              <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                  required
                  disabled={!ready || saving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter the new password"
                  required
                  disabled={!ready || saving}
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                variant="premium"
                disabled={!ready || saving}
              >
                {saving ? "Saving..." : "Update password"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => navigate("/auth", { replace: true })}
              >
                Back to sign in
              </Button>
            </form>
            </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
