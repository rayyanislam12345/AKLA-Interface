import { ReactNode, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { useAuth } from '@/hooks/useAuth';
import { MFAVerification } from '@/components/MFAVerification';
import { useOwnProfileStatus } from '@/hooks/useProfiles';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import aklaLogo from '@/assets/akla-logo.png';

interface ProtectedRouteProps {
  children: ReactNode;
}

function StatusScreen({ title, description }: { title: string; description: string }) {
  const { signOut } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <img src={aklaLogo} alt="Ali Khan Law Associates" className="h-10 w-auto max-w-[220px] object-contain" />
        </div>
        <Card className="border-border/50 shadow-elegant">
          <CardHeader className="text-center">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="w-full" onClick={() => signOut()}>
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** The `aal` claim of the session's access token ("aal1" after a password,
 * "aal2" after an authenticator code too), or null if it can't be read. */
function sessionAssuranceLevel(session: Session): string | null {
  try {
    const payload = session.access_token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { aal?: string };
    return claims.aal ?? null;
  } catch {
    return null;
  }
}

/** The authenticator factor this session still has to be verified with, or
 * null if none is needed. Same rule supabase.auth.mfa
 * .getAuthenticatorAssuranceLevel() applies (a verified factor on the user
 * means the next level is aal2), worked out synchronously from the session so
 * moving between pages never flashes a spinner. */
function pendingSecondFactor(session: Session | null): string | null {
  if (!session) return null;
  const factor = session.user.factors?.find((f) => f.factor_type === 'totp' && f.status === 'verified');
  if (!factor) return null;
  return sessionAssuranceLevel(session) === 'aal2' ? null : factor.id;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, session, loading, signOut } = useAuth();
  const { data: status, isLoading: statusLoading } = useOwnProfileStatus();
  // Set once the code is accepted, so the page shows straight away rather
  // than waiting for the upgraded session to arrive through useAuth.
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null);

  if (loading || (user && statusLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // Two-step sign-in: someone who has set up an authenticator app but has
  // only typed their password this session (or typed a page address to skip
  // the code screen) must enter the code before seeing anything. The same
  // check /auth makes after a password sign-in.
  const factorId = pendingSecondFactor(session);
  if (factorId && factorId !== verifiedFactorId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <img src={aklaLogo} alt="Ali Khan Law Associates" className="h-10 w-auto max-w-[220px] object-contain" />
          </div>
          <MFAVerification
            factorId={factorId}
            onSuccess={() => setVerifiedFactorId(factorId)}
            onCancel={() => signOut()}
          />
        </div>
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <StatusScreen
        title="Awaiting approval"
        description="Your account has been created and is waiting on an admin to approve it. You'll be able to sign in once that's done — no need to sign up again."
      />
    );
  }

  if (status === 'rejected') {
    return (
      <StatusScreen
        title="Access not approved"
        description="An admin has not approved this account for AKLA Project Hub. If you believe this is a mistake, contact your firm admin directly."
      />
    );
  }

  return <>{children}</>;
};
