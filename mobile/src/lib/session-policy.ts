import { fetchAccessContext, forgetAccessContext } from './access-context';
import { supabase } from './supabase';

export type MobileSessionPolicy = {
  expired: boolean;
  expiresAt: number | null;
};

export async function enforceMobileSessionPolicy(): Promise<MobileSessionPolicy> {
  const { data: auth } = await supabase.auth.getSession();
  if (!auth.session) return { expired: false, expiresAt: null };

  const context = await fetchAccessContext().catch(() => null);
  if (!context) return { expired: false, expiresAt: null };

  const expiresAt = context.session_expires_at
    ? Date.parse(context.session_expires_at)
    : Number.NaN;
  const expired =
    (context.destination === 'LOGIN' && context.reason === 'SESSION_EXPIRED') ||
    (Number.isFinite(expiresAt) && expiresAt <= Date.now());

  if (expired) {
    forgetAccessContext();
    await supabase.auth.signOut({ scope: 'local' });
    return { expired: true, expiresAt: null };
  }

  return { expired: false, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}
