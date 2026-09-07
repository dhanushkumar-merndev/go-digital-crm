// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';
import { runAiCallProcessing } from './ai-call-processing';
import { runAiImageGeneration } from './ai-image-generation';
import { runAiVoiceEscalation } from './ai-voice-escalation';
import { runMarketingDispatch } from './marketing-dispatch';
import { runProviderEventDispatch } from './provider-event-dispatch';
import { runProviderOutbox } from './provider-outbox';

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

/**
 * Every per-minute queue in one schedule. The project allows 10 schedules and
 * six tasks all ran on this same cron, which left no room to add anything; each
 * is a bounded claim against its own table, so running them together costs the
 * same work as running them apart.
 *
 * Every step is settled independently. These queues are unrelated -- a provider
 * outage in one must not stop transcription, image generation or the outbox --
 * so a rejection is recorded and reported, never thrown out of the pass.
 */
export const minuteDispatch = schedules.task({
  id: 'minute-dispatch',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  // Was the tightest ttl of the merged tasks (provider-event-dispatch); a run
  // that has waited longer than this is stale because the next one is due.
  ttl: '5m',
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const steps = {
      call_processing: runAiCallProcessing,
      image_generation: runAiImageGeneration,
      voice_escalation: runAiVoiceEscalation,
      provider_events: runProviderEventDispatch,
      provider_outbox: runProviderOutbox,
      marketing: runMarketingDispatch,
    } as const;

    const names = Object.keys(steps) as Array<keyof typeof steps>;
    const settled = await Promise.allSettled(names.map((name) => steps[name](supabase)));

    const result: Record<string, unknown> = {};
    const failures: string[] = [];
    settled.forEach((outcome, index) => {
      const name = names[index];
      if (outcome.status === 'fulfilled') {
        result[name] = outcome.value;
        return;
      }
      const reason = outcome.reason instanceof Error ? outcome.reason.message : 'UNKNOWN';
      result[name] = { failed: reason };
      failures.push(`${name}: ${reason}`);
    });
    // Surfaced so a persistently failing queue is visible in the run list rather
    // than hidden inside a run that always reports success.
    if (failures.length) result.failures = failures;
    return result;
  },
});
