import { AlertCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PasswordUpdateForm } from '@/features/auth/password-update-form';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invite?: string }>;
}) {
  const { error: recoveryError, invite } = await searchParams;
  let authenticated = false;

  if (
    recoveryError !== 'invalid_link' &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      authenticated = Boolean(data.user);
    } catch {
      authenticated = false;
    }
  }

  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
          <CardDescription>
            Use at least eight characters with a letter and a number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {authenticated ? (
            <PasswordUpdateForm continueHref={invite === '1' ? '/access/mfa' : '/'} />
          ) : (
            <div className="space-y-5">
              <Alert variant="destructive" role="alert">
                <AlertCircle className="size-4" />
                <AlertDescription>{getSafeAuthErrorMessage('RECOVERY_SESSION')}</AlertDescription>
              </Alert>
              <Button variant="outline" className="w-full" asChild>
                <Link href="/forgot-password">
                  <ArrowLeft className="size-4" />
                  Request a new link
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
