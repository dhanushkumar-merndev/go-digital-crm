import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { CrmShell } from '@/components/shared/crm-shell';
import { isRoleKey } from '@/config/navigation';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { createClient } from '@/lib/supabase/server';
import { toWorkspaceSession, workspaceBootstrapSchema } from '@/lib/auth/workspace-bootstrap';
import {
  decodeWorkspaceBootstrapHeader,
  WORKSPACE_BOOTSTRAP_HEADER,
} from '@/lib/auth/workspace-bootstrap-header';

export default async function RoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ role: string }>;
}) {
  const { role } = await params;
  if (!isRoleKey(role)) notFound();

  let workspaceSession = null;

  // Route names are presentation presets, never an authorization source. This
  // prevents a Sales Consultant account opened through an old /telecaller URL
  // from being labelled as a Telecaller in the shell.
  if (!isLocalPreviewMode()) {
    const requestHeaders = await headers();
    const forwarded = decodeWorkspaceBootstrapHeader(
      requestHeaders.get(WORKSPACE_BOOTSTRAP_HEADER),
    );
    let data: unknown = forwarded;
    let bootstrapFailed = false;
    if (!data) {
      const supabase = await createClient();
      const result = await supabase.rpc('get_workspace_bootstrap');
      data = result.data;
      bootstrapFailed = Boolean(result.error);
    }
    const parsed = workspaceBootstrapSchema.safeParse(data);
    const context = parsed.success ? parsed.data : null;
    if (bootstrapFailed || !context) redirect('/access/locked');
    if (context.destination === 'LOGIN') redirect('/login');
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
    workspaceSession = toWorkspaceSession(context);
    if (!workspaceSession) redirect('/access/locked');
  }
  return (
    <CrmShell role={role} session={workspaceSession}>
      {children}
    </CrmShell>
  );
}
