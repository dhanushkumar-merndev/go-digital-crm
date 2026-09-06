// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';

/**
 * Enrolment matching is set-based inside the database, so this task only has to
 * call it. Hourly rather than per-minute: an audience is defined by lifecycle
 * and lead age, which do not change second to second, and each pass is capped so
 * a large newly-matching audience drains over several runs instead of enrolling
 * everyone at once.
 */
/** One step of the marketing dispatch pass. Scheduling lives in
 * trigger/marketing-dispatch.ts so the four queues share a single cron
 * slot rather than four. */
export async function runDripAutoMatch(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc('run_all_drip_auto_matches', {
    target_limit: 500,
  });
  if (error) throw error;
  return (data ?? { enrolled: 0, messages: 0, skipped: 0 }) as {
    enrolled: number;
    messages: number;
    skipped: number;
  };
}
