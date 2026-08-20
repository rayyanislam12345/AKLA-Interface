import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { BrainCircuit } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { MFAVerification } from '@/components/MFAVerification';
import { MFAEnrollment } from '@/components/MFAEnrollment';

type AuthStep = 'login' | 'mfa-verify' | 'mfa-required' | 'forgot-password' | 'accept-invite' | 'invite-mfa';

// Detect invite synchronously before first render so the redirect effect never fires
function detectInvite() {
  return window.location.hash.includes('type=invite');
}

export default function Auth() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStep, setAuthStep] = useState<AuthStep>(() => detectInvite() ? 'accept-invite' : 'login');
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [inviteOrgName, setInviteOrgName] = useState('');
  const [inviteFullName, setInviteFullName] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [inviteConfirmPassword, setInviteConfirmPassword] = useState('');

  // Load org name from user metadata once Supabase processes the invite token
  useEffect(() => {
    if (authStep !== 'accept-invite') return;
    const load = async () => {
      // Wait briefly for Supabase to exchange the hash tokens
      await new Promise(r => setTimeout(r, 600));
      const { data: { user: invitedUser } } = await supabase.auth.getUser();
      if (invitedUser?.user_metadata?.organization_name) {
        setInviteOrgName(invitedUser.user_metadata.organization_name);
      }
      if (invitedUser?.user_metadata?.full_name) {
        setInviteFullName(invitedUser.user_metadata.full_name);
      }
    };
    load();
  }, [authStep]);

  // Redirect authenticated users with completed MFA to home
  useEffect(() => {
    const checkAuthAndMFA = async () => {
      if (user && authStep === 'login') {
        // Check if user has MFA factors
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const verifiedFactors = factors?.totp?.filter(f => f.status === 'verified') || [];
        
        if (verifiedFactors.length > 0) {
          // User has MFA, check AAL level
          const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aal?.currentLevel === 'aal1') {
            // Need MFA verification
            setMfaFactorId(verifiedFactors[0].id);
            setAuthStep('mfa-verify');
            return;
          }
        }
        
        // No MFA or already verified, proceed to home
        navigate('/dashboard', { replace: true });
      }
    };

    checkAuthAndMFA();
  }, [user, authStep, navigate]);

  const handleSignIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    const { error } = await signIn(email, password);
    
    if (error) {
      setError(error.message);
      toast({
        title: "Sign in failed",
        description: error.message,
        variant: "destructive"
      });
      setIsLoading(false);
      return;
    }

    // Check for MFA requirement after successful password login
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const verifiedFactors = factors?.totp?.filter(f => f.status === 'verified') || [];
    
    if (verifiedFactors.length > 0) {
      // User has MFA set up, need to verify
      setMfaFactorId(verifiedFactors[0].id);
      setAuthStep('mfa-verify');
    } else {
      toast({
        title: "Welcome back!",
        description: "You have successfully signed in."
      });
      navigate('/dashboard', { replace: true });
    }
    
    setIsLoading(false);
  };

  const handleMFASuccess = () => {
    toast({
      title: "Welcome back!",
      description: "You have successfully signed in."
    });
    navigate('/dashboard', { replace: true });
  };

  const handleMFACancel = async () => {
    await supabase.auth.signOut();
    setAuthStep('login');
    setMfaFactorId(null);
  };

  const handleMFAEnrollmentSuccess = () => {
    setEnrollDialogOpen(false);
    toast({
      title: "MFA set up successfully!",
      description: "You can now sign in."
    });
    navigate('/dashboard', { replace: true });
  };

  const handleForgotPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    // Use the current origin for the redirect (works in both dev and prod)
    const redirectUrl = `${window.location.origin}/reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(forgotPasswordEmail, {
      redirectTo: redirectUrl,
    });

    if (error) {
      setError(error.message);
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive"
      });
    } else {
      setResetEmailSent(true);
      toast({
        title: "Check your email",
        description: "We've sent you a password reset link."
      });
    }

    setIsLoading(false);
  };

  const handleAcceptInvite = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (invitePassword !== inviteConfirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (invitePassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setIsLoading(true);
    setError(null);

    const updates: { password: string; data?: { full_name: string } } = { password: invitePassword };
    if (inviteFullName.trim()) {
      updates.data = { full_name: inviteFullName.trim() };
    }

    const { error } = await supabase.auth.updateUser(updates);
    if (error) {
      setError(error.message);
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
    // Offer optional 2FA setup
    setAuthStep('invite-mfa');
  };

  // Accept invite screen
  if (authStep === 'accept-invite') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
                <BrainCircuit className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
                <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
              </div>
            </div>
          </div>
          <Card className="border-border/50 shadow-elegant">
            <CardHeader className="text-center">
              <CardTitle>You've been invited!</CardTitle>
              <CardDescription>
                {inviteOrgName
                  ? `Set a password to join ${inviteOrgName} on FactorIQ.`
                  : 'Set a password to complete your account setup.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <form onSubmit={handleAcceptInvite} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="invite-name">Full name</Label>
                  <Input
                    id="invite-name"
                    type="text"
                    placeholder="Your full name"
                    value={inviteFullName}
                    onChange={(e) => setInviteFullName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-password">Password</Label>
                  <Input
                    id="invite-password"
                    type="password"
                    placeholder="Choose a password"
                    value={invitePassword}
                    onChange={(e) => setInvitePassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invite-confirm">Confirm password</Label>
                  <Input
                    id="invite-confirm"
                    type="password"
                    placeholder="Confirm your password"
                    value={inviteConfirmPassword}
                    onChange={(e) => setInviteConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={isLoading} variant="premium">
                  {isLoading ? 'Setting up account...' : 'Create account'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Post-invite optional 2FA setup screen
  if (authStep === 'invite-mfa') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
                <BrainCircuit className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
                <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
              </div>
            </div>
          </div>
          <Card className="border-border/50 shadow-elegant">
            <CardHeader className="text-center">
              <CardTitle>Account created!</CardTitle>
              <CardDescription>
                Would you like to set up two-factor authentication for extra security?
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                className="w-full"
                variant="premium"
                onClick={() => setEnrollDialogOpen(true)}
              >
                Set up Two-Factor Authentication
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  toast({ title: 'Welcome to FactorIQ!', description: 'You can enable 2FA later in settings.' });
                  navigate('/dashboard', { replace: true });
                }}
              >
                Skip for now
              </Button>
            </CardContent>
          </Card>
          <MFAEnrollment
            open={enrollDialogOpen}
            onOpenChange={setEnrollDialogOpen}
            onSuccess={() => {
              setEnrollDialogOpen(false);
              toast({ title: 'Two-factor authentication enabled!', description: 'Your account is now secured.' });
              navigate('/dashboard', { replace: true });
            }}
          />
        </div>
      </div>
    );
  }

  // MFA Verification screen
  if (authStep === 'mfa-verify' && mfaFactorId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
                <BrainCircuit className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
                <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
              </div>
            </div>
          </div>
          <MFAVerification 
            factorId={mfaFactorId} 
            onSuccess={handleMFASuccess}
            onCancel={handleMFACancel}
          />
        </div>
      </div>
    );
  }

  // MFA Required screen (org requires MFA but user doesn't have it)
  if (authStep === 'mfa-required') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
                <BrainCircuit className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
                <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
              </div>
            </div>
          </div>
          <Card className="border-border/50 shadow-elegant">
            <CardHeader className="text-center">
              <CardTitle>MFA Required</CardTitle>
              <CardDescription>
                Your organization requires two-factor authentication. Please set it up to continue.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button 
                className="w-full" 
                variant="premium"
                onClick={() => setEnrollDialogOpen(true)}
              >
                Set up Two-Factor Authentication
              </Button>
              <Button 
                variant="ghost" 
                className="w-full"
                onClick={handleMFACancel}
              >
                Sign out
              </Button>
            </CardContent>
          </Card>
          <MFAEnrollment
            open={enrollDialogOpen}
            onOpenChange={setEnrollDialogOpen}
            onSuccess={handleMFAEnrollmentSuccess}
          />
        </div>
      </div>
    );
  }

  // Forgot password screen
  if (authStep === 'forgot-password') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
                <BrainCircuit className="w-7 h-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
                <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
              </div>
            </div>
          </div>
          <Card className="border-border/50 shadow-elegant">
            <CardHeader className="text-center">
              <CardTitle>Reset your password</CardTitle>
              <CardDescription>
                {resetEmailSent 
                  ? "Check your email for a reset link."
                  : "Enter your email and we'll send you a reset link."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {!resetEmailSent ? (
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reset-email">Email</Label>
                    <Input
                      id="reset-email"
                      type="email"
                      placeholder="Enter your email"
                      value={forgotPasswordEmail}
                      onChange={(e) => setForgotPasswordEmail(e.target.value)}
                      required
                    />
                  </div>
                  <Button 
                    type="submit" 
                    className="w-full"
                    disabled={isLoading}
                    variant="premium"
                  >
                    {isLoading ? "Sending..." : "Send reset link"}
                  </Button>
                  <Button 
                    variant="ghost" 
                    className="w-full"
                    onClick={() => {
                      setAuthStep('login');
                      setError(null);
                      setForgotPasswordEmail('');
                    }}
                  >
                    Back to sign in
                  </Button>
                </form>
              ) : (
                <Button 
                  variant="ghost" 
                  className="w-full"
                  onClick={() => {
                    setAuthStep('login');
                    setError(null);
                    setResetEmailSent(false);
                    setForgotPasswordEmail('');
                  }}
                >
                  Back to sign in
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-muted/50 p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center space-x-3">
            <div className="flex items-center justify-center w-12 h-12 bg-gradient-primary rounded-lg">
              <BrainCircuit className="w-7 h-7 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">FactorIQ</h1>
              <p className="text-sm text-muted-foreground">AI-Powered PE Analytics</p>
            </div>
          </div>
        </div>

        <Card className="w-full border-border/50 shadow-elegant">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Welcome</CardTitle>
            <CardDescription className="text-center">
              Sign in to your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  name="email"
                  type="email"
                  placeholder="Enter your email"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signin-password">Password</Label>
                <Input
                  id="signin-password"
                  name="password"
                  type="password"
                  placeholder="Enter your password"
                  required
                />
              </div>
              <Button 
                type="submit" 
                className="w-full"
                disabled={isLoading}
                variant="premium"
              >
                {isLoading ? "Signing in..." : "Sign In"}
              </Button>
              <Button
                type="button"
                variant="link"
                className="w-full text-sm"
                onClick={() => {
                  setAuthStep('forgot-password');
                  setError(null);
                }}
              >
                Forgot your password?
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
