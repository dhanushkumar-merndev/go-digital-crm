'use client';

import {
  CircleAlert,
  Clock3,
  CloudAlert,
  LockKeyhole,
  Settings2,
  ShieldCheck,
  UserRoundX,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { MfaGate } from '@/features/auth/mfa-gate';
import { BusinessOwnerOnboarding } from '@/features/auth/business-owner-onboarding';
import { createClient } from '@/lib/supabase/client';

const states = {
  configuration: {
    title: 'CRM configuration is unavailable',
    body: 'This deployment cannot access its Supabase project configuration. CRM data and authenticated routes remain closed until an administrator completes the environment setup and redeploys.',
    icon: Settings2,
  },
  locked: {
    title: 'Account access is unavailable',
    body: 'This account or dealership is inactive, suspended, rejected, or scheduled for controlled deletion. Contact an authorized administrator and share your account email.',
    icon: LockKeyhole,
  },
  unavailable: {
    title: 'Access check is temporarily unavailable',
    body: 'We could not verify your workspace access right now. Your account has not been marked inactive. Check again, or sign out and retry if the problem continues.',
    icon: CloudAlert,
  },
  onboarding: {
    title: 'Dealership onboarding in progress',
    body: 'Complete the required company and compliance information, or wait for the Super Admin review decision. Normal CRM modules remain protected until activation.',
    icon: Clock3,
  },
  maintenance: {
    title: 'CRM under support maintenance',
    body: 'An approved, time-limited support session is active. Normal tenant users cannot read or change CRM data until the session ends.',
    icon: ShieldCheck,
  },
  'no-role': {
    title: 'No active role assignment',
    body: 'Your identity is valid, but no active role and data scope has been assigned. Ask your Client Admin to complete the assignment.',
    icon: UserRoundX,
  },
} as const;

export default function AccessStatePage() {
  const { state } = useParams<{ state: string }>();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [checking, setChecking] = useState(false);
  if (state === 'mfa') return <MfaGate />;
  if (state === 'onboarding') return <BusinessOwnerOnboarding />;
  const content = states[state as keyof typeof states] ?? states.unavailable;
  const Icon = content.icon;

  async function signOutAndSwitchAccount() {
    setSigningOut(true);
    try {
      await createClient().auth.signOut({ scope: 'local' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  function checkAgain() {
    setChecking(true);
    router.replace('/');
    router.refresh();
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/40 p-6">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-14 place-items-center rounded-full bg-blue-50 text-blue-700">
            <Icon className="size-6" />
          </div>
          <h1 className="mt-5 text-xl font-bold">{content.title}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{content.body}</p>
          <div className="mt-6 flex gap-2">
            <Button type="button" variant="outline" disabled={checking} onClick={checkAgain}>
              {checking ? 'Checking…' : 'Check again'}
            </Button>
            {state === 'locked' || state === 'unavailable' ? (
              <Button
                type="button"
                variant="ghost"
                disabled={signingOut}
                onClick={() => void signOutAndSwitchAccount()}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => router.back()}>
              <CircleAlert className="size-4" />
              Go back
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
