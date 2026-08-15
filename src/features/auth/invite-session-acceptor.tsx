'use client';

import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

export function InviteSessionAcceptor() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient();
        const query = new URLSearchParams(window.location.search);
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const code = query.get('code');
        const tokenHash = query.get('token_hash');
        const accessToken = fragment.get('access_token');
        const refreshToken = fragment.get('refresh_token');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: 'invite',
          });
          if (error) throw error;
        } else if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) throw error;
        } else {
          throw new Error('INVITE_SESSION_MISSING');
        }
        router.replace('/reset-password?invite=1');
        router.refresh();
      } catch {
        window.history.replaceState({}, '', '/auth/invite?error=invalid_link');
        setFailed(true);
      }
    })();
  }, [router]);

  if (failed)
    return (
      <div className="space-y-5">
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            This invitation is invalid or expired. Ask the platform administrator to send a new
            invite.
          </AlertDescription>
        </Alert>
        <Button variant="outline" className="w-full" asChild>
          <Link href="/login">Return to sign in</Link>
        </Button>
      </div>
    );

  return (
    <div className="grid min-h-32 place-items-center" role="status">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
        Verifying your one-time invitation…
      </div>
    </div>
  );
}
