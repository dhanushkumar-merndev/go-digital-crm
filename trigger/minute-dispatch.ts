// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';
import { runAiCallProcessing } from './ai-call-processing';
import { runAiImageGeneration } from './ai-image-generation';
import { runAiVoiceEscalation } from './ai-voice-escalation';
import { runAutoCallDialer } from './auto-call-dialer';
import { runMarketingDispatch } from './marketing-dispatch';
import { runPortalInboxDue } from './portal-inbox-sync';
import { runProviderEventDispatch } from './provider-event-dispatch';
import { runProviderOutbox } from './provider-outbox';
import { runStuckRecordingSweep } from './provider-recording-ingest';
import { runReportExport } from './report-export';
import { runSupportSessionExpiry } from './support-session-expiry';
import { runVehicleComparisonAiExpiry } from './vehicle-comparison-ai-expiry';

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
    // Sweeps that only recover stuck rows wait minutes by design, so they run on
    // a slower beat inside this pass rather than querying every minute.
    const minute = new Date().getUTCMinutes();
    const idle = async () => 'skipped';
    const steps = {
      call_processing: runAiCallProcessing,
      image_generation: runAiImageGeneration,
      voice_escalation: runAiVoiceEscalation,
      // Keypad auto calls for telecallers who switched Auto call on.
      auto_call: runAutoCallDialer,
      provider_events: runProviderEventDispatch,
      provider_outbox: runProviderOutbox,
      // A recording is swept only 10 minutes after its last attempt.
      recording_sweep: minute % 10 === 3 ? runStuckRecordingSweep : idle,
      marketing: runMarketingDispatch,
      // Each portal mailbox carries its own 10 / 20 / 30 minute interval; this
      // only starts the runs whose next_poll_at has passed.
      portal_inbox: runPortalInboxDue,
      // Refunds comparisons stuck for over 2 minutes; nobody waits on it.
      comparison_expiry: minute % 5 === 1 ? runVehicleComparisonAiExpiry : idle,
      // A lapsed support window keeps the tenant on the maintenance screen
      // until this ends it, so it keeps the per-minute beat.
      support_session_expiry: runSupportSessionExpiry,
      report_export: runReportExport,
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
