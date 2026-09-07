// Database RPCs are the generated-schema boundary for this scheduled worker.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';

type ClaimedJob = { id: string; lease_token: string };
type PreparedJob = {
  eligible: boolean;
  job_id?: string;
  organization_id?: string;
  call_id?: string;
  lead_id?: string;
  external_agent_id?: string;
  language?: string;
  credit_cost?: number;
  customer_phone?: string;
  idempotency_key?: string;
  context?: Record<string, unknown>;
};
type DispatchAuthorization = {
  authorized?: boolean;
  reason?: string;
  reservation_id?: string;
};

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function safeCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]{3,100}$/.test(message) ? message : 'AI_VOICE_GATEWAY_RETRY';
}

/** One step of the per-minute pass. Scheduling lives in
 * trigger/minute-dispatch.ts: the project allows 10 schedules and six
 * tasks shared this same cron, so they share one slot instead. */
export async function runAiVoiceEscalation(supabase: ReturnType<typeof createClient>) {
  const { data: jobs, error: claimError } = await supabase.rpc<ClaimedJob[]>(
    'claim_ai_voice_escalations',
    {
      target_worker_id: `trigger:ai-voice-escalation:${crypto.randomUUID()}`,
      target_batch_size: 5,
    },
  );
  if (claimError) throw claimError;
  let dispatched = 0;
  let skipped = 0;
  let retried = 0;
  for (const job of jobs ?? []) {
    let gatewayAccepted = false;
    let acceptedProviderCallId: string | null = null;
    let creditReservationId: string | null = null;
    try {
      const { data, error } = await supabase.rpc('prepare_ai_voice_escalation', {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
      });
      if (error) throw error;
      const prepared = data as PreparedJob;
      if (!prepared.eligible) {
        skipped += 1;
        continue;
      }
      if (
        !prepared.organization_id ||
        !prepared.call_id ||
        !prepared.external_agent_id ||
        !prepared.customer_phone ||
        !prepared.idempotency_key ||
        !prepared.credit_cost
      )
        throw new Error('AI_VOICE_PREPARE_INVALID');
      const authorizationResult = await supabase.rpc('authorize_ai_voice_escalation', {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
      });
      if (authorizationResult.error)
        throw new Error(
          authorizationResult.error.message.includes('INSUFFICIENT_CREDITS')
            ? 'INSUFFICIENT_CREDITS'
            : 'AI_VOICE_AUTHORIZATION_FAILED',
        );
      const authorization = authorizationResult.data as DispatchAuthorization;
      if (!authorization.authorized) {
        skipped += 1;
        continue;
      }
      if (!authorization.reservation_id) throw new Error('AI_CREDIT_RESERVATION_FAILED');
      creditReservationId = authorization.reservation_id;
      const callbackBase = requiredEnvironment('PUBLIC_EDGE_FUNCTION_BASE_URL').replace(/\/$/, '');
      const response = await fetch(requiredEnvironment('AI_VOICE_GATEWAY_URL'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requiredEnvironment('AI_VOICE_GATEWAY_TOKEN')}`,
          'content-type': 'application/json',
          'idempotency-key': prepared.idempotency_key,
        },
        body: JSON.stringify({
          external_agent_id: prepared.external_agent_id,
          to: prepared.customer_phone,
          language: prepared.language,
          context: prepared.context,
          metadata: {
            organization_id: prepared.organization_id,
            crm_call_id: prepared.call_id,
            lead_id: prepared.lead_id,
          },
          callback_url: `${callbackBase}/provider-webhook-ai-voice`,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await response.json().catch(() => null)) as {
        call_id?: string;
        accepted?: boolean;
      } | null;
      if (!response.ok || result?.accepted === false || !result?.call_id?.trim())
        throw new Error(response.status === 429 ? 'AI_VOICE_RATE_LIMITED' : 'AI_VOICE_REJECTED');
      gatewayAccepted = true;
      acceptedProviderCallId = result.call_id.trim();
      const completed = await supabase.rpc('complete_ai_voice_escalation', {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
        target_provider_call_id: acceptedProviderCallId,
        target_credit_reservation_id: authorization.reservation_id,
      });
      if (completed.error || !completed.data) throw new Error('AI_VOICE_LEASE_LOST');
      dispatched += 1;
    } catch (error) {
      if (gatewayAccepted && acceptedProviderCallId && creditReservationId) {
        const recovered = await supabase.rpc('recover_ai_voice_gateway_acceptance', {
          target_job_id: job.id,
          target_provider_call_id: acceptedProviderCallId,
          target_credit_reservation_id: creditReservationId,
        });
        if (recovered.error || !recovered.data)
          throw new Error('AI_VOICE_ACCEPTED_STATE_UNCERTAIN');
        dispatched += 1;
        continue;
      }
      const retriedJob = await supabase.rpc('retry_ai_voice_escalation', {
        target_job_id: job.id,
        target_lease_token: job.lease_token,
        target_safe_error_code: safeCode(error),
      });
      if (retriedJob.error) throw retriedJob.error;
      retried += 1;
    }
  }
  return { claimed: jobs?.length ?? 0, dispatched, skipped, retried };
}
