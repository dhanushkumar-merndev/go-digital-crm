// The generated Supabase schema is guarded by the SQL RPC contract in migration 031.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { analyzeCall, translateCallTurns } from './providers/groq-text';
import { downloadSarvamResult, getSarvamJobStatus, submitSarvamJob } from './providers/sarvam-stt';

// Call recordings are transcribed on the platform's Sarvam account (speaker
// separation on), then translated and summarised on the platform's Groq
// account. Tenants pay in AI credits: Sarvam's cost plus the platform margin,
// priced in SQL (`quote_ai_call_credits`) so the UI estimate and the charge
// agree. A Sarvam job runs asynchronously, so a pass either submits it and
// parks the job, or collects a finished one; it never waits on the provider.

type Job = {
  id: string;
  organization_id: string;
  branch_id: string;
  call_id: string;
  lead_id: string | null;
  recording_id: string;
  lease_token: string;
  object_bucket: string;
  object_key: string;
  mime_type: string;
  size_bytes: number | string | null;
  known_duration_seconds: number | null;
  provider_job_id: string | null;
  provider_submitted_at: string | null;
  provider_poll_count: number;
  credits_held: number | null;
  generation: number;
};

type Supabase = ReturnType<typeof createClient>;

// Sarvam accepts files of up to two hours; a job still running after three
// hours is treated as lost and its hold is returned.
const maxAudioSeconds = 2 * 60 * 60;
const providerTimeoutMs = 3 * 60 * 60 * 1000;
// With no known length, the hold assumes a low phone-recorder bitrate, which
// over-estimates the length; the charge is settled on the real length.
const conservativeBitsPerSecond = 32_000;

// Failures that another attempt cannot fix end the job at once.
const terminalCodes = new Set([
  'INSUFFICIENT_CREDITS',
  'SARVAM_JOB_FAILED',
  'SARVAM_TIMEOUT',
  'SARVAM_AUDIO_TOO_LONG',
  'SARVAM_EMPTY_TRANSCRIPT',
]);

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function platformProviders() {
  return {
    sarvamKey: requiredEnvironment('SARVAM_API_KEY'),
    sarvamModel: process.env.SARVAM_STT_MODEL?.trim() || 'saaras:v3',
    groqKey: requiredEnvironment('GROQ_API_KEY'),
    groqModel: requiredEnvironment('GROQ_ANALYSIS_MODEL'),
  };
}

function storageClient() {
  return new S3Client({
    endpoint: requiredEnvironment('TIGRIS_ENDPOINT'),
    region: process.env.TIGRIS_REGION?.trim() || 'auto',
    credentials: {
      accessKeyId: requiredEnvironment('TIGRIS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('TIGRIS_SECRET_ACCESS_KEY'),
    },
  });
}

function referencePrefix(job: Job) {
  return `ai-call:${job.id}:${job.recording_id}:g${job.generation}`;
}

async function quoteCredits(supabase: Supabase, seconds: number) {
  const { data, error } = await supabase.rpc('quote_ai_call_credits', {
    target_seconds: Math.max(1, Math.min(86_400, Math.ceil(seconds))),
  });
  if (error || typeof data !== 'number') throw new Error('AI_CREDIT_QUOTE_FAILED');
  return data;
}

async function reserveCredits(
  supabase: Supabase,
  organizationId: string,
  amount: number,
  referenceId: string,
) {
  const reservation = await supabase.rpc('reserve_ai_credits', {
    target_organization_id: organizationId,
    target_amount: amount,
    target_feature: 'call_transcription',
    target_reference_id: referenceId,
  });
  if (reservation.error || !reservation.data)
    throw new Error(
      reservation.error?.message.includes('INSUFFICIENT_CREDITS')
        ? 'INSUFFICIENT_CREDITS'
        : reservation.error?.message.includes('AI_CREDIT_REFERENCE_REVERSED')
          ? 'AI_CREDIT_REFERENCE_REVERSED'
          : 'AI_CREDIT_RESERVATION_FAILED',
    );
  return reservation.data as string;
}

async function rpcTrue(
  supabase: Supabase,
  name: string,
  args: Record<string, unknown>,
  code: string,
) {
  const { data, error } = await supabase.rpc(name, args);
  if (error || data !== true) throw new Error(code);
}

/** Pass 1: hold the estimated credits, then hand the recording to Sarvam. */
async function submit(
  supabase: Supabase,
  storage: S3Client,
  job: Job,
  providers: ReturnType<typeof platformProviders>,
) {
  const sizeBytes = Number(job.size_bytes ?? 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('CALL_RECORDING_EMPTY');
  const estimatedSeconds =
    job.known_duration_seconds ?? Math.ceil((sizeBytes * 8) / conservativeBitsPerSecond);
  if (job.known_duration_seconds && job.known_duration_seconds > maxAudioSeconds)
    throw new Error('SARVAM_AUDIO_TOO_LONG');
  const held = await quoteCredits(supabase, Math.min(estimatedSeconds, maxAudioSeconds));
  await reserveCredits(supabase, job.organization_id, held, `${referencePrefix(job)}:hold`);

  const object = await storage.send(
    new GetObjectCommand({ Bucket: job.object_bucket, Key: job.object_key }),
  );
  if (!object.Body) throw new Error('CALL_RECORDING_UNREADABLE');
  const extension =
    job.object_key
      .split('.')
      .pop()
      ?.replace(/[^a-z0-9]/gi, '') || 'audio';
  const providerJobId = await submitSarvamJob({
    apiKey: providers.sarvamKey,
    model: providers.sarvamModel,
    audio: {
      body: object.Body.transformToWebStream(),
      sizeBytes,
      fileName: `call-${job.call_id}.${extension.toLowerCase()}`,
      mimeType: job.mime_type,
    },
  });
  await rpcTrue(
    supabase,
    'record_ai_call_provider_submission',
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_provider_job_id: providerJobId,
      target_credits_held: held,
    },
    'AI_CALL_PROCESSING_LEASE_LOST',
  );
  return 'submitted' as const;
}

/**
 * Charges the real length: the hold is committed when it already matches,
 * otherwise released and replaced by the exact amount. If the exact amount no
 * longer fits the balance, the job is charged what was held.
 */
async function settleCredits(supabase: Supabase, job: Job, actualSeconds: number) {
  const held = job.credits_held;
  if (!held) throw new Error('AI_CREDIT_HOLD_MISSING');
  const holdReference = `${referencePrefix(job)}:hold`;
  const actual = await quoteCredits(supabase, actualSeconds);
  let reservationId: string;
  if (actual === held) {
    reservationId = await reserveCredits(supabase, job.organization_id, held, holdReference);
  } else {
    try {
      const holdId = await reserveCredits(supabase, job.organization_id, held, holdReference);
      const { error } = await supabase.rpc('reverse_ai_credit_reservation', {
        target_reservation_id: holdId,
      });
      if (error) throw new Error('AI_CREDIT_RELEASE_FAILED');
    } catch (error) {
      // Already released by an earlier pass of this job.
      if (!(error instanceof Error) || error.message !== 'AI_CREDIT_REFERENCE_REVERSED')
        throw error;
    }
    try {
      reservationId = await reserveCredits(
        supabase,
        job.organization_id,
        actual,
        `${referencePrefix(job)}:charge`,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'INSUFFICIENT_CREDITS') throw error;
      reservationId = await reserveCredits(
        supabase,
        job.organization_id,
        held,
        `${referencePrefix(job)}:charge-held`,
      );
      return { reservationId, charged: held };
    }
    return { reservationId, charged: actual };
  }
  return { reservationId, charged: held };
}

/** Pass 2+: collect Sarvam's result, translate, summarise, charge, complete. */
async function collect(
  supabase: Supabase,
  job: Job,
  providers: ReturnType<typeof platformProviders>,
) {
  const providerJobId = job.provider_job_id as string;
  const submittedAt = Date.parse(job.provider_submitted_at ?? '');
  if (Number.isFinite(submittedAt) && Date.now() - submittedAt > providerTimeoutMs)
    throw new Error('SARVAM_TIMEOUT');
  const status = await getSarvamJobStatus({ apiKey: providers.sarvamKey, jobId: providerJobId });
  if (status.state === 'RUNNING') {
    await rpcTrue(
      supabase,
      'defer_ai_call_provider_poll',
      { target_job_id: job.id, target_lease_token: job.lease_token },
      'AI_CALL_PROCESSING_LEASE_LOST',
    );
    return 'waiting' as const;
  }
  if (status.state === 'FAILED') throw new Error('SARVAM_JOB_FAILED');

  const result = await downloadSarvamResult({
    apiKey: providers.sarvamKey,
    jobId: providerJobId,
    outputFile: status.outputFile,
  });
  const durationSeconds = Math.max(
    1,
    Math.min(86_400, result.durationSeconds ?? job.known_duration_seconds ?? 1),
  );
  await rpcTrue(
    supabase,
    'save_ai_call_provider_transcript',
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_raw_transcript: result.transcript,
      target_language: result.languageCode,
      target_speaker_turns: result.turns.map((turn) => ({
        speaker: 'UNKNOWN',
        text: turn.text,
        original_text: turn.text,
        start: turn.start,
        end: turn.end,
      })),
      target_audio_duration_seconds: durationSeconds,
      target_provider_reference: `sarvam:${providers.sarvamModel}:${providerJobId}`.slice(0, 200),
    },
    'AI_TRANSCRIPTION_SAVE_FAILED',
  );

  const translation = await translateCallTurns({
    apiKey: providers.groqKey,
    model: providers.groqModel,
    languageCode: result.languageCode,
    turns: result.turns.map((turn) => ({ speakerId: turn.speakerId, text: turn.text })),
  });
  const turns = result.turns.map((turn, index) => ({
    speaker: translation.roles[turn.speakerId] ?? 'UNKNOWN',
    text: translation.english[index] ?? turn.text,
    original_text: turn.text,
    start: turn.start,
    end: turn.end,
  }));
  const englishTranscript = turns
    .map((turn) => `${turn.speaker === 'UNKNOWN' ? 'SPEAKER' : turn.speaker}: ${turn.text}`)
    .join('\n');
  const { data: callRow } = await supabase
    .from('calls')
    .select('started_at')
    .eq('id', job.call_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle<{ started_at: string | null }>();
  const analysis = await analyzeCall({
    apiKey: providers.groqKey,
    model: providers.groqModel,
    transcript: englishTranscript,
    callStartedAt: callRow?.started_at ?? null,
  });
  await rpcTrue(
    supabase,
    'save_ai_call_analysis_result',
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_normalized_transcript: englishTranscript,
      target_speaker_turns: turns,
      target_separation_method: 'PROVIDER_DIARIZATION',
      target_summary: analysis.summary,
      target_suggestions: analysis.fields,
      target_analysis_model_reference: `groq:${providers.groqModel}`,
    },
    'AI_ANALYSIS_SAVE_FAILED',
  );

  const { reservationId, charged } = await settleCredits(supabase, job, durationSeconds);
  const commit = await supabase.rpc('commit_ai_credit_reservation', {
    target_reservation_id: reservationId,
  });
  if (commit.error || !commit.data) throw new Error('AI_CREDIT_COMMIT_FAILED');
  await rpcTrue(
    supabase,
    'complete_ai_call_processing_job',
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_billing_mode: 'PLATFORM_CREDITS',
      target_credits_consumed: charged,
    },
    'AI_CALL_PROCESSING_LEASE_LOST',
  );
  return 'completed' as const;
}

async function processJob(supabase: Supabase, storage: S3Client, job: Job) {
  const providers = platformProviders();
  return job.provider_job_id
    ? collect(supabase, job, providers)
    : submit(supabase, storage, job, providers);
}

/** One step of the per-minute pass. Scheduling lives in
 * trigger/minute-dispatch.ts: the project allows 10 schedules and six
 * tasks shared this same cron, so they share one slot instead. */
export async function runAiCallProcessing(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc<Job[]>('claim_ai_call_processing_jobs', {
    target_worker_id: `trigger:ai-call-processing:${crypto.randomUUID()}`,
    target_batch_size: 2,
  });
  if (error) throw error;
  const storage = storageClient();
  const outcomes = { submitted: 0, waiting: 0, completed: 0, retried: 0, failed: 0 };
  for (const job of data ?? []) {
    try {
      outcomes[await processJob(supabase, storage, job)] += 1;
    } catch (error) {
      const safeCode =
        error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)
          ? error.message
          : 'AI_CALL_PROCESSING_RETRY';
      const terminal = terminalCodes.has(safeCode);
      const { error: settleError } = await supabase.rpc(
        terminal ? 'fail_ai_call_processing_job' : 'retry_ai_call_processing_job',
        {
          target_job_id: job.id,
          target_lease_token: job.lease_token,
          target_safe_error_code: safeCode,
        },
      );
      if (settleError) throw settleError;
      outcomes[terminal ? 'failed' : 'retried'] += 1;
    }
  }
  return { claimed: data?.length ?? 0, ...outcomes };
}
