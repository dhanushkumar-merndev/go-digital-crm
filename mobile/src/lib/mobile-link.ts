import { supabase } from './supabase';

export async function exchangeMobileLink(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'godigitalcrm:' || parsed.hostname !== 'link')
    throw new Error('INVALID_MOBILE_LINK');
  const challengeId = parsed.searchParams.get('challenge');
  const nonce = parsed.searchParams.get('nonce');
  if (!challengeId || !nonce) throw new Error('INVALID_MOBILE_LINK');
  const { data, error } = await supabase.functions.invoke<{ data?: { token_hash: string } }>(
    'mobile-link-exchange',
    { body: { challenge_id: challengeId, nonce } },
  );
  if (error || !data?.data?.token_hash) throw error ?? new Error('MOBILE_LINK_EXCHANGE_FAILED');
  const { error: verificationError } = await supabase.auth.verifyOtp({
    token_hash: data.data.token_hash,
    type: 'email',
  });
  if (verificationError) throw verificationError;
  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return { mfaRequired: assurance?.nextLevel === 'aal2' && assurance.currentLevel !== 'aal2' };
}
