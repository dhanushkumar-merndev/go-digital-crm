import { redirect } from 'next/navigation';
import { isRoleKey } from '@/config/navigation';
import { createClient } from '@/lib/supabase/server';

type AccessContext = {
  destination?: string;
  role_key?: string;
};

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await supabase.rpc('get_access_context');
  const context = data as AccessContext | null;
  if (error || !context) redirect('/access/locked');

  if (context.destination === 'CRM' && isRoleKey(context.role_key ?? ''))
    redirect(`/${context.role_key}/dashboard`);
  if (context.destination === 'MFA') redirect('/access/mfa');
  if (context.destination === 'ONBOARDING') redirect('/access/onboarding');
  if (context.destination === 'MAINTENANCE') redirect('/access/maintenance');
  if (context.destination === 'NO_ROLE') redirect('/access/no-role');
  redirect('/access/locked');
}
