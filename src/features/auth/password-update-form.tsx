'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { getSafeAuthErrorMessage } from '@/lib/auth/safe-errors';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/toast';

const schema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must contain at least 8 characters')
      .regex(/[A-Za-z]/, 'Password must contain at least one letter')
      .regex(/\d/, 'Password must contain at least one number'),
    confirmation: z.string(),
  })
  .refine((values) => values.password === values.confirmation, {
    path: ['confirmation'],
    message: 'Passwords do not match',
  });

type FormValues = z.infer<typeof schema>;

export function PasswordUpdateForm({ continueHref = '/' }: { continueHref?: string }) {
  const [complete, setComplete] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmation: '' },
  });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    try {
      const { error: updateError } = await createClient().auth.updateUser({ password });
      if (updateError) throw updateError;
      form.reset();
      setComplete(true);
      toast.add({
        type: 'success',
        title: 'Password updated',
        description: 'Your new password is active for future sign-ins.',
      });
    } catch {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Password update failed',
        description: getSafeAuthErrorMessage('PASSWORD_UPDATE'),
      });
    }
  });

  if (complete) {
    return (
      <div className="space-y-5">
        <p className="text-sm leading-6 text-muted-foreground">
          Your new password is active for future sign-ins.
        </p>
        <Button className="w-full" asChild>
          <Link href={continueHref}>
            Continue to CRM
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <PasswordInput
            id="new-password"
            className="pl-9"
            autoComplete="new-password"
            {...form.register('password')}
          />
        </div>
        {form.formState.errors.password && (
          <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          {...form.register('confirmation')}
        />
        {form.formState.errors.confirmation && (
          <p className="text-xs text-destructive">{form.formState.errors.confirmation.message}</p>
        )}
      </div>
      <Button className="w-full" type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Updating password…' : 'Update password'}
      </Button>
    </form>
  );
}
