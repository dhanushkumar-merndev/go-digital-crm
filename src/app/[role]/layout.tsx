import { notFound, redirect } from 'next/navigation';
import { CrmShell } from '@/components/shared/crm-shell';
import { isRoleKey } from '@/config/navigation';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { createClient } from '@/lib/supabase/server';

type AccessContext = {
  destination?: string;
  role_key?: string;
};

export default async function RoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ role: string }>;
}) {
  const { role } = await params;
  if (!isRoleKey(role)) notFound();

  // Route names are presentation presets, never an authorization source. This
  // prevents a Sales Consultant account opened through an old /telecaller URL
  // from being labelled as a Telecaller in the shell.
  if (!isLocalPreviewMode()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect('/login');
    const { data, error } = await supabase.rpc('get_access_context');
    const context = data as AccessContext | null;
    if (error || !context) redirect('/access/locked');
    if (
      context.destination === 'CRM' &&
      isRoleKey(context.role_key ?? '') &&
      context.role_key !== role
    )
      redirect(`/${context.role_key}/dashboard`);
    if (context.destination === 'MFA') redirect('/access/mfa');
    if (context.destination === 'ONBOARDING') redirect('/access/onboarding');
    if (context.destination === 'MAINTENANCE') redirect('/access/maintenance');
    if (context.destination === 'NO_ROLE') redirect('/access/no-role');
    if (context.destination !== 'CRM') redirect('/access/locked');
  }
  return <CrmShell role={role}>{children}</CrmShell>;
}
