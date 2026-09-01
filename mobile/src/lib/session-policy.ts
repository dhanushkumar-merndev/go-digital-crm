import { supabase } from './supabase';

type SessionPolicyContext = {
  destination?: string;
  reason?: string;
  session_expires_at?: string;
};

export type MobileSessionPolicy = {
  expired: boolean;
  expiresAt: number | null;
};

export async function enforceMobileSessionPolicy(): Promise<MobileSessionPolicy> {
  const { data: auth } = await supabase.auth.getSession();
  if (!auth.session) return { expired: false, expiresAt: null };

  const { data, error } = await supabase.rpc('get_access_context');
  if (error || !data) return { expired: false, expiresAt: null };

  const context = data as SessionPolicyContext;
  const expiresAt = context.session_expires_at
    ? Date.parse(context.session_expires_at)
    : Number.NaN;
  const expired =
    (context.destination === 'LOGIN' && context.reason === 'SESSION_EXPIRED') ||
    (Number.isFinite(expiresAt) && expiresAt <= Date.now());

  if (expired) {
    await supabase.auth.signOut({ scope: 'local' });
    return { expired: true, expiresAt: null };
  }

  return { expired: false, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}
