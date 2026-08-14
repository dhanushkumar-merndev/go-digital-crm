'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, LockKeyhole, Mail } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Password must contain at least 8 characters'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(undefined);
    if (!hasSupabaseConfig()) {
      setError(
        'Supabase is not configured in this environment. Use the role workspace preview from the home page.',
      );
      return;
    }
    const { error: authError } = await createClient().auth.signInWithPassword(values);
    if (authError) {
      setError(authError.message);
      return;
    }
    router.push('/telecaller/dashboard');
  });
  return (
    <main className="grid min-h-screen bg-[#f5f7fb] lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden bg-[#17233d] p-14 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-blue-500 text-sm font-black">
            GO
          </div>
          <div>
            <p className="font-bold">Go Digital Marketing CRM</p>
            <p className="text-xs text-slate-400">Automobile dealership workspace</p>
          </div>
        </div>
        <div className="max-w-xl">
          <p className="text-sm font-semibold text-blue-300">One connected customer journey</p>
          <h1 className="mt-4 text-4xl font-bold leading-tight">
            Turn every dealership enquiry into a well-managed relationship.
          </h1>
          <p className="mt-5 max-w-lg text-sm leading-6 text-slate-300">
            Secure tenant isolation, role-based workflows, sales operations and post-booking
            coordination in one system.
          </p>
        </div>
        <p className="text-xs text-slate-500">© 2026 Go Digital Marketing</p>
      </section>
      <section className="grid place-items-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-2xl">Welcome back</CardTitle>
            <CardDescription>Sign in with your verified work email.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Email address</span>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    type="email"
                    autoComplete="email"
                    {...form.register('email')}
                  />
                </div>
                {form.formState.errors.email && (
                  <span className="text-xs text-destructive">
                    {form.formState.errors.email.message}
                  </span>
                )}
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Password</span>
                <div className="relative">
                  <LockKeyhole className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    type="password"
                    autoComplete="current-password"
                    {...form.register('password')}
                  />
                </div>
                {form.formState.errors.password && (
                  <span className="text-xs text-destructive">
                    {form.formState.errors.password.message}
                  </span>
                )}
              </label>
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}
              <Button className="w-full" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
                <ArrowRight className="size-4" />
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Privileged users complete TOTP verification after password authentication.
              </p>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
