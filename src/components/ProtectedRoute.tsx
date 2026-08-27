import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
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

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, loading } = useAuth();
  const { data: status, isLoading: statusLoading } = useOwnProfileStatus();

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
        description="An admin has not approved this account for AKLA Matter Hub. If you believe this is a mistake, contact your firm admin directly."
      />
    );
  }

  return <>{children}</>;
};
