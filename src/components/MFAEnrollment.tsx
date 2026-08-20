import React, { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, Copy, Check } from 'lucide-react';

interface MFAEnrollmentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export const MFAEnrollment = ({ open, onOpenChange, onSuccess }: MFAEnrollmentProps) => {
  const [step, setStep] = useState<'loading' | 'qr' | 'verify'>('loading');
  const [qrCode, setQrCode] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [factorId, setFactorId] = useState<string>('');
  const [verifyCode, setVerifyCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      enrollMFA();
    } else {
      // Reset state when dialog closes
      setStep('loading');
      setQrCode('');
      setSecret('');
      setFactorId('');
      setVerifyCode('');
    }
  }, [open]);

  const enrollMFA = async () => {
    setStep('loading');
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator App'
      });

      if (error) throw error;

      if (data?.totp) {
        setQrCode(data.totp.qr_code);
        setSecret(data.totp.secret);
        setFactorId(data.id);
        setStep('qr');
      }
    } catch (error: any) {
      toast({
        title: 'Error setting up MFA',
        description: error.message,
        variant: 'destructive',
      });
      onOpenChange(false);
    }
  };

  const verifyAndActivate = async () => {
    if (verifyCode.length !== 6) {
      toast({
        title: 'Invalid code',
        description: 'Please enter a 6-digit code',
        variant: 'destructive',
      });
      return;
    }

    setIsVerifying(true);
    try {
      // Create a challenge
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });

      if (challengeError) throw challengeError;

      // Verify the code
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code: verifyCode,
      });

      if (verifyError) throw verifyError;

      toast({
        title: 'MFA enabled',
        description: 'Two-factor authentication has been set up successfully.',
      });

      onSuccess?.();
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: 'Verification failed',
        description: error.message || 'Invalid code. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Set up Two-Factor Authentication
          </DialogTitle>
          <DialogDescription>
            Use an authenticator app like Google Authenticator, Authy, or 1Password to scan the QR code.
          </DialogDescription>
        </DialogHeader>

        {step === 'loading' && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {step === 'qr' && (
          <div className="space-y-4">
            <div className="flex justify-center">
              <div className="bg-white p-4 rounded-lg">
                <img src={qrCode} alt="QR Code for MFA" className="w-48 h-48" />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">
                Can't scan? Enter this code manually:
              </Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono break-all">
                  {secret}
                </code>
                <Button variant="outline" size="icon" onClick={copySecret}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button className="w-full" onClick={() => setStep('verify')}>
              Continue to Verification
            </Button>
          </div>
        )}

        {step === 'verify' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="verify-code">Enter the 6-digit code from your authenticator app</Label>
              <Input
                id="verify-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                className="text-center text-2xl tracking-widest"
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('qr')} className="flex-1">
                Back
              </Button>
              <Button 
                onClick={verifyAndActivate} 
                disabled={isVerifying || verifyCode.length !== 6}
                className="flex-1"
              >
                {isVerifying ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Verify & Enable
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
