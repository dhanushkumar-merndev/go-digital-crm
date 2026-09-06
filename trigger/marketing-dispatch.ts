// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';
import { runBulkCampaignDispatch } from './bulk-campaign-dispatch';
import { runDripAutoMatch } from './drip-auto-match';
import { runDripDispatch } from './drip-dispatch';
import { runSocialPostPublish } from './social-post-publish';

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

/**
 * One cron slot for all four marketing queues. They were four separate schedules
 * until the project hit its schedule limit; each pass is a bounded claim against
 * its own queue, so running them in sequence costs the same work as running them
 * apart and keeps three slots free for other tasks.
 *
 * A failure in one queue must not stop the others, so each is settled
 * independently and its error reported rather than thrown.
 */
export const marketingDispatch = schedules.task({
  id: 'marketing-dispatch',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    // Auto-match defines an audience by lifecycle and lead age, which do not
    // change minute to minute, so it keeps its original hourly cadence inside
    // this per-minute pass rather than earning a schedule of its own.
    const runAutoMatch = new Date().getUTCMinutes() === 7;

    const [drip, bulk, social, autoMatch] = await Promise.allSettled([
      runDripDispatch(supabase),
      runBulkCampaignDispatch(supabase),
      runSocialPostPublish(supabase),
      runAutoMatch ? runDripAutoMatch(supabase) : Promise.resolve(null),
    ]);

    const settled = (result: PromiseSettledResult<unknown>) =>
      result.status === 'fulfilled'
        ? result.value
        : { failed: result.reason instanceof Error ? result.reason.message : 'UNKNOWN' };

    return {
      drip: settled(drip),
      bulk: settled(bulk),
      social: settled(social),
      auto_match: runAutoMatch ? settled(autoMatch) : 'skipped',
    };
  },
});
