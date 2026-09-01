import type { Href } from 'expo-router';
import { supabase } from './supabase';

type AccessContext = { destination: string; role_key?: string; reason?: string };

export async function routeForCurrentSession(): Promise<Href> {
  const { data, error } = await supabase.rpc('get_access_context');
  if (error || !data) throw error ?? new Error('ACCESS_CONTEXT_MISSING');
  const context = data as AccessContext;
  if (context.destination === 'LOGIN' && context.reason === 'SESSION_EXPIRED') {
    await supabase.auth.signOut({ scope: 'local' });
    throw new Error('SESSION_EXPIRED');
  }
  if (context.destination === 'MFA') return '/mfa';
  if (context.destination !== 'CRM') throw new Error(`ACCESS_${context.destination}`);
  if (context.role_key === 'telecaller') return '/telecaller/home';
  if (context.role_key === 'sales-consultant') return '/sales/home';
  throw new Error('MOBILE_ROLE_NOT_ELIGIBLE');
}
