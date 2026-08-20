import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

function parseHashParams(hash: string) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw);
}

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        const access_token = params.hash.get("access_token") ?? params.search.get("access_token");
        const refresh_token = params.hash.get("refresh_token") ?? params.search.get("refresh_token");
        const code = params.search.get("code");

        // Most Supabase recovery links arrive as #access_token=...&refresh_token=...
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token,
            refresh_token,
          });
          if (error) throw error;
          setReady(true);
          return;
        }

        // Some flows can arrive as ?code=... (PKCE)
        if (code && "exchangeCodeForSession" in supabase.auth) {
          const { error } = await (supabase.auth as any).exchangeCodeForSession(code);
          if (error) throw error;
          setReady(true);
          return;
        }

        setError(
          "This reset link is missing required tokens. Please request a new password reset email."
        );
      } catch (e: any) {
        setError(e?.message ?? "Failed to validate reset link.");
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

    if (!password || password.length < 6) {
      setError("Password must be at least 6 characters.");
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
    } catch (e: any) {
      setError(e?.message ?? "Failed to update password.");
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
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter a new password"
                  required
                  disabled={!ready || saving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
