'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AuthPageShell } from '@/components/shared/auth-page-shell';
import { AuthLink } from '@/features/auth/auth-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';
import { toast } from '@/components/ui/toast';

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Password must contain at least 8 characters'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    if (!hasSupabaseConfig()) {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Sign in unavailable',
        description: getSafeAuthErrorMessage('SIGN_IN'),
      });
      return;
    }
    try {
      const { error: authError } = await createClient().auth.signInWithPassword(values);
      if (authError) throw authError;
      // A shared browser can move between tenants/users. Never carry a prior
      // subject's in-memory CRM data into the newly authenticated session.
      queryClient.clear();
      toast.add({
        type: 'success',
        title: 'Signed in successfully',
        description: 'Opening your workspace…',
      });
      router.replace('/');
      router.refresh();
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Sign in failed',
        description: getSafeAuthErrorMessage('SIGN_IN'),
      });
    }
  });
  return (
    <AuthPageShell>
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>Sign in with your verified work email.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <div className="flex h-5 items-center">
                <Label htmlFor="login-email">Email address</Label>
              </div>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-email"
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
            <div className="space-y-2">
              <div className="flex h-5 items-center justify-between gap-3">
                <Label htmlFor="login-password">Password</Label>
                <AuthLink
                  href="/forgot-password"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Forgot password?
                </AuthLink>
              </div>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <PasswordInput
                  id="login-password"
                  className="pl-9"
                  autoComplete="current-password"
                  {...form.register('password')}
                />
              </div>
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
              )}
            </div>
            <Button className="w-full" type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
              <ArrowRight className="size-4" />
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Privileged users complete TOTP verification after password authentication.
            </p>
          </form>
        </CardContent>
      </Card>
    </AuthPageShell>
  );
}
