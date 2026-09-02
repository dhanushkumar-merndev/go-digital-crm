'use client';

import { ArrowLeft, KeyRound, LoaderCircle } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';

type Factor = { id: string };

/**
 * Wrong codes end the session rather than letting someone sit on this screen
 * guessing. This is a usability limit, not the security control: a reload
 * resets the count, and Supabase's own rate limiting is what actually bounds
 * how fast codes can be tried.
 */
const MAX_VERIFICATION_ATTEMPTS = 3;

export function MfaGate() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [factor, setFactor] = useState<Factor>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient();
        const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (assurance?.currentLevel === 'aal2') {
          router.replace('/');
          router.refresh();
          return;
        }
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const verified = factors?.totp.find((item) => item.status === 'verified');
        if (verified) {
          setFactor(verified);
          return;
        }
        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: 'Go Digital CRM',
        });
        if (enrollError) throw enrollError;
        setFactor(data);
        // Supabase can return the SVG data URI with trailing whitespace,
        // which next/image rejects outright ("src cannot end with a space
        // or control character").
        setQr(data.totp.qr_code?.trim());
      } catch {
        toast.add({
          type: 'error',
          priority: 'high',
          title: 'MFA setup failed',
          description: 'MFA setup could not be loaded. Check your session and try again.',
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  /**
   * Signing in leaves a real session behind at this screen -- it is
   * authenticated, just not yet at aal2 -- so simply navigating away would
   * bounce straight back here as the same person, and the next sign-in would
   * be theirs rather than a clean one. Leaving therefore has to end the
   * session, not just the page.
   */
  async function signOutAndReturn(reason?: string) {
    if (leaving) return;
    setLeaving(true);
    const supabase = createClient();
    try {
      // An enrollment abandoned here leaves an unverified factor on the
      // account, and the next visit enrolls another one on top of it.
      if (qr && factor) await supabase.auth.mfa.unenroll({ factorId: factor.id });
    } catch {
      // Best effort: an orphaned factor must not keep anyone signed in.
    }
    try {
      queryClient.clear();
      // Local scope: this is someone switching accounts on this device, not
      // revoking their sessions everywhere else.
      await supabase.auth.signOut({ scope: 'local' });
    } finally {
      router.replace(reason ? `/login?reason=${reason}` : '/login');
      router.refresh();
    }
  }

  async function verify() {
    if (submitting) return;
    if (!factor || !/^\d{6}$/.test(code)) {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Enter a valid verification code',
        description: 'Enter the 6-digit code from your authenticator app.',
      });
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) throw verifyError;
      toast.add({
        type: 'success',
        title: 'MFA verified',
        description: 'Opening your workspace…',
      });
      router.replace('/');
      router.refresh();
    } catch {
      const attempts = failedAttempts + 1;
      setFailedAttempts(attempts);
      setCode('');
      if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
        toast.add({
          type: 'error',
          priority: 'high',
          title: 'Signed out after too many attempts',
          description: `The code was wrong ${MAX_VERIFICATION_ATTEMPTS} times. Sign in again to retry.`,
        });
        setSubmitting(false);
        void signOutAndReturn('mfa-attempts');
        return;
      }
      const remaining = MAX_VERIFICATION_ATTEMPTS - attempts;
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Verification failed',
        description: `The code was not accepted. ${remaining} ${
          remaining === 1 ? 'attempt' : 'attempts'
        } left before you are signed out. Wait for a new code and try again.`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <CardTitle>Secure your account</CardTitle>
          <CardDescription>
            {qr
              ? 'Scan this one-time enrollment QR with an authenticator app, then verify the code.'
              : 'Enter the current code from your enrolled authenticator app.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="grid h-44 place-items-center">
              <LoaderCircle className="size-6 animate-spin text-primary" />
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              {qr && (
                <div className="mx-auto w-fit rounded-xl border bg-white p-3">
                  <Image
                    unoptimized
                    src={qr}
                    width={176}
                    height={176}
                    alt="TOTP authenticator enrollment QR code"
                  />
                </div>
              )}
              <label className="block space-y-2">
                <span className="text-sm font-medium">6-digit verification code</span>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    className="px-9 text-center font-mono text-lg tracking-[.35em]"
                  />
                </div>
              </label>
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || leaving || code.length !== 6}
              >
                {submitting ? 'Verifying…' : 'Verify and continue'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={submitting || leaving}
                onClick={() => void signOutAndReturn()}
              >
                {leaving ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowLeft className="size-4" />
                )}
                {leaving ? 'Signing out…' : 'Back to sign in'}
              </Button>
              <p className="text-center text-[11px] leading-5 text-muted-foreground">
                Enter the 6-digit verification code displayed in your authenticator app.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
