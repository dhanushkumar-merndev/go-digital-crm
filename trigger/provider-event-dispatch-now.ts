import { createClient } from '@supabase/supabase-js';
import { task } from '@trigger.dev/sdk';
import { runProviderEventDispatch } from './provider-event-dispatch';

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

// No cron wait: the webhook starts this task after storing a receipt. Existing
// leases and domain RPCs still enforce idempotency and tenant/branch routing.
export const providerEventDispatchNow = task({
  id: 'provider-event-dispatch-now',
  queue: { concurrencyLimit: 10 },
  maxDuration: 120,
  ttl: '2m',
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10_000 },
  run: async (payload: { eventIds: string[] }) => {
    if (!payload || !Array.isArray(payload.eventIds)) throw new Error('INVALID_PROVIDER_EVENT_IDS');
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    return runProviderEventDispatch(supabase, payload.eventIds);
  },
});
