import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One step of the per-minute pass: end support windows past their approved
 * limit and return the tenant to ACTIVE. The access gate reads only the tenant
 * status, so until this runs the tenant's users stay on the maintenance screen.
 * It had its own every-minute schedule, which spent a run a minute on a table
 * that is almost always empty; as a step it is one extra RPC in a pass that
 * already runs.
 */
export async function runSupportSessionExpiry(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('expire_support_sessions');
  if (error) throw error;
  return { expired_sessions: data ?? 0 };
}
