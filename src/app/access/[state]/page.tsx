'use client';

import { CircleAlert, Clock3, LockKeyhole, ShieldCheck, UserRoundX } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { MfaGate } from '@/features/auth/mfa-gate';

const states = {
  locked: {
    title: 'Account access is unavailable',
    body: 'This account or dealership is inactive, suspended, rejected, or scheduled for controlled deletion. Contact an authorized administrator and share your account email.',
    icon: LockKeyhole,
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
  if (state === 'mfa') return <MfaGate />;
  const content = states[state as keyof typeof states] ?? states.locked;
  const Icon = content.icon;
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
            <Button variant="outline" onClick={() => window.location.reload()}>
              Check again
            </Button>
            <Button variant="ghost" onClick={() => history.back()}>
              <CircleAlert className="size-4" />
              Go back
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
