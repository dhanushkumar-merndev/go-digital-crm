// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

/**
 * Enrolment matching is set-based inside the database, so this task only has to
 * call it. Hourly rather than per-minute: an audience is defined by lifecycle
 * and lead age, which do not change second to second, and each pass is capped so
 * a large newly-matching audience drains over several runs instead of enrolling
 * everyone at once.
 */
export const dripAutoMatch = schedules.task({
  id: 'drip-auto-match',
  cron: { pattern: '7 * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase.rpc('run_all_drip_auto_matches', {
      target_limit: 500,
    });
    if (error) throw error;
    return (data ?? { enrolled: 0, messages: 0, skipped: 0 }) as {
      enrolled: number;
      messages: number;
      skipped: number;
    };
  },
});
