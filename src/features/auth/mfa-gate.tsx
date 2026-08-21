'use client';

import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  fetchTenantDashboard,
  tenantDashboardKey,
} from '@/features/dashboards/tenant-dashboard-api';
import { createClient } from '@/lib/supabase/client';

type Factor = { id: string };

export function MfaGate() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [factor, setFactor] = useState<Factor>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

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
        setError('MFA setup could not be loaded. Check your session and try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  async function verify() {
    if (!factor || !/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    setError(undefined);
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
      void queryClient.prefetchQuery({
        queryKey: tenantDashboardKey,
        queryFn: ({ signal }) => fetchTenantDashboard(signal),
      });
      router.replace('/');
      router.refresh();
    } catch {
      setError('The verification code was not accepted. Wait for a new code and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <div className="mb-2 grid size-11 place-items-center rounded-xl bg-blue-50 text-blue-700">
            <ShieldCheck />
          </div>
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
            <>
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
                    className="pl-9 text-center text-lg tracking-[.35em]"
                  />
                </div>
              </label>
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}
              <Button
                className="w-full"
                disabled={submitting || code.length !== 6}
                onClick={() => void verify()}
              >
                {submitting ? 'Verifying…' : 'Verify and continue'}
              </Button>
              <p className="text-center text-[11px] leading-5 text-muted-foreground">
                For security, the enrollment QR is shown only during setup. MFA verification is also
                enforced by database assurance-level policies.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
