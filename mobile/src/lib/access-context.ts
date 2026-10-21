import { supabase } from './supabase';

export type AccessContext = {
  destination?: string;
  role_key?: string;
  reason?: string;
  session_expires_at?: string;
};

const reuseMs = 15_000;
let cached: { at: number; promise: Promise<AccessContext> } | undefined;

// Startup asked the server who the user is three times (session policy, the
// login redirect and the role lookup). Callers inside a short window share one
// request; failures are never reused.
export function fetchAccessContext(): Promise<AccessContext> {
  if (cached && Date.now() - cached.at < reuseMs) return cached.promise;
  const promise = (async () => {
    const { data, error } = await supabase.rpc('get_access_context');
    if (error || !data) throw error ?? new Error('ACCESS_CONTEXT_MISSING');
    return data as AccessContext;
  })();
  const entry = { at: Date.now(), promise };
  cached = entry;
  promise.catch(() => {
    if (cached === entry) cached = undefined;
  });
  return promise;
}

export function forgetAccessContext() {
  cached = undefined;
}

// Sign-in, sign-out, MFA verification and token refresh all change what the
// server would answer, so none of them may reuse an earlier response.
supabase.auth.onAuthStateChange(() => forgetAccessContext());
