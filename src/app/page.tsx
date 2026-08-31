import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isRoleKey } from '@/config/navigation';
import {
  decodeWorkspaceBootstrapHeader,
  WORKSPACE_BOOTSTRAP_HEADER,
} from '@/lib/auth/workspace-bootstrap-header';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { createClient } from '@/lib/supabase/server';
import { isTransientSupabaseError } from '@/lib/supabase/transient-error';

type AccessContext = {
  destination?: string;
  role_key?: string;
};

export default async function HomePage() {
  if (isLocalPreviewMode()) redirect('/sales-consultant/dashboard');

  const requestHeaders = await headers();
  let context = decodeWorkspaceBootstrapHeader(
    requestHeaders.get(WORKSPACE_BOOTSTRAP_HEADER),
  ) as AccessContext | null;
  if (!context) {
    const supabase = await createClient();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData?.claims?.sub) redirect('/login');
    let { data, error } = await supabase.rpc('get_workspace_bootstrap');
    if (isTransientSupabaseError(error))
      ({ data, error } = await supabase.rpc('get_workspace_bootstrap'));
    if (error || !data) redirect('/access/unavailable');
    context = data as AccessContext;
  }

  if (context.destination === 'CRM' && isRoleKey(context.role_key ?? ''))
    redirect(`/${context.role_key}/dashboard`);
  if (context.destination === 'LOGIN') redirect('/login');
  if (context.destination === 'MFA') redirect('/access/mfa');
  if (context.destination === 'ONBOARDING') redirect('/access/onboarding');
  if (context.destination === 'MAINTENANCE') redirect('/access/maintenance');
  if (context.destination === 'NO_ROLE') redirect('/access/no-role');
  if (context.destination === 'ACCOUNT_LOCKED') redirect('/access/locked');
  redirect('/access/unavailable');
}
