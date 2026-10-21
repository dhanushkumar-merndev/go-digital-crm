import type { SupabaseClient } from '@supabase/supabase-js';

// The PIOPIY adapter, its credentials and prompt recordings live in Supabase
// Edge Functions (AGENTS.md 12.4); this step only asks the dispatcher to dial.
function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

/**
 * True when the dispatcher has anything to do: a dialer switched on and not
 * paused, or a DIALING / IN_CALL job its timeout sweep may need to close. Both
 * probes read a partial index that is empty while nobody uses Auto call.
 */
async function autoCallActive(supabase: SupabaseClient) {
  const [dialers, openJobs] = await Promise.all([
    supabase
      .from('auto_call_dialers')
      .select('user_id')
      .eq('enabled', true)
      .is('paused_reason', null)
      .limit(1),
    supabase.from('auto_call_jobs').select('id').in('status', ['DIALING', 'IN_CALL']).limit(1),
  ]);
  if (dialers.error) throw dialers.error;
  if (openJobs.error) throw openJobs.error;
  return (dialers.data?.length ?? 0) > 0 || (openJobs.data?.length ?? 0) > 0;
}

/**
 * One step of the per-minute pass: dial the next lead for every idle
 * telecaller with Auto call on. A finished call also dials straight from the
 * PIOPIY webhook, so this is the fallback that keeps the queue moving.
 *
 * The edge function call was the slowest part of an idle pass, paid every
 * minute whether or not anyone had Auto call on, so it is skipped when the
 * probe finds nothing.
 */
export async function runAutoCallDialer(supabase: SupabaseClient) {
  if (!(await autoCallActive(supabase))) return { skipped: 'NO_ACTIVE_DIALERS' };
  const serviceKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(
    `${requiredEnvironment('SUPABASE_URL').replace(/\/$/, '')}/functions/v1/auto-call-dispatch`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(50_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error?.code ?? 'AUTO_CALL_DISPATCH_FAILED');
  return body.data;
}
