'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, CheckCircle2, Mail } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

const schema = z.object({ email: z.email('Enter a valid email address') });
type FormValues = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setError(undefined);
    if (!hasSupabaseConfig()) {
      setError(getSafeAuthErrorMessage('PASSWORD_RESET_REQUEST'));
      return;
    }

    try {
      const callback = new URL('/auth/callback', window.location.origin);
      callback.searchParams.set('next', '/reset-password');
      const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
        redirectTo: callback.toString(),
      });
      if (resetError) throw resetError;
      setSubmitted(true);
    } catch {
      setError(getSafeAuthErrorMessage('PASSWORD_RESET_REQUEST'));
    }
  });

  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <CardDescription>
            Enter your verified work email to receive a short-lived recovery link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <div className="space-y-5">
              <Alert variant="success" role="status">
                <CheckCircle2 className="size-4" />
                <div>
                  <AlertTitle>Check your email</AlertTitle>
                  <AlertDescription>
                    If an account matches that address, a password recovery email will arrive
                    shortly.
                  </AlertDescription>
                </div>
              </Alert>
              <Button variant="outline" className="w-full" asChild>
                <Link href="/login">
                  <ArrowLeft className="size-4" />
                  Back to sign in
                </Link>
              </Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <Label htmlFor="recovery-email">Email address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="recovery-email"
                    className="pl-9"
                    type="email"
                    autoComplete="email"
                    {...form.register('email')}
                  />
                </div>
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button className="w-full" type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Sending recovery email…' : 'Send recovery email'}
              </Button>
              <Button variant="ghost" className="w-full" asChild>
                <Link href="/login">
                  <ArrowLeft className="size-4" />
                  Back to sign in
                </Link>
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
