import type { Href } from 'expo-router';
import { fetchAccessContext, forgetAccessContext } from './access-context';
import { supabase } from './supabase';

export async function routeForCurrentSession(): Promise<Href> {
  const context = await fetchAccessContext();
  if (context.destination === 'LOGIN' && context.reason === 'SESSION_EXPIRED') {
    forgetAccessContext();
    await supabase.auth.signOut({ scope: 'local' });
    throw new Error('SESSION_EXPIRED');
  }
  if (context.destination === 'MFA') return '/mfa';
  if (context.destination !== 'CRM') throw new Error(`ACCESS_${context.destination}`);
  if (context.role_key === 'telecaller') return '/telecaller/home';
  if (context.role_key === 'sales-consultant') return '/sales/home';
  throw new Error('MOBILE_ROLE_NOT_ELIGIBLE');
}
