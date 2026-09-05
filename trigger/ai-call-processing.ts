// The generated Supabase schema is guarded by the SQL RPC contract in migration 031.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

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
};
type GroqCredential = { api_key: string };

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function configuredCredits(name: string) {
  const value = Number(process.env[name] ?? '1');
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
    throw new Error(`${name}_INVALID`);
  return value;
}

function fromBase64Url(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

async function decryptCredential<T>(value: unknown): Promise<T> {
  if (typeof value !== 'string') throw new Error('INTEGRATION_CREDENTIAL_INVALID');
  const bytes = value.startsWith('\\x')
    ? Uint8Array.from(Buffer.from(value.slice(2), 'hex'))
    : fromBase64Url(value);
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
    version: string;
    iv: string;
    ciphertext: string;
  };
  if (envelope.version !== 'AES-256-GCM-v1')
    throw new Error('INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED');
  const keyBytes = fromBase64Url(requiredEnvironment('INTEGRATION_ENCRYPTION_KEY'));
  if (keyBytes.byteLength !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY_INVALID');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
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

async function findTenantGroq(supabase: ReturnType<typeof createClient>, job: Job) {
  const { data: connections, error } = await supabase
    .from('connected_accounts')
    .select('id,scope_mode,connection_config')
    .eq('organization_id', job.organization_id)
    .eq('provider_key', 'groq')
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  for (const connection of connections ?? []) {
    const config = connection.connection_config as {
      capabilities?: string[];
      models?: { transcription_model?: string; analysis_model?: string };
    } | null;
    if (
      !config?.capabilities?.includes('AUDIO_TRANSCRIPTION') ||
      !config.capabilities.includes('AI_CALL_ANALYSIS') ||
      !config.models?.transcription_model ||
      !config.models?.analysis_model
    )
      continue;
    if (connection.scope_mode !== 'ALL_BRANCHES') {
      const { data: mapping, error: mappingError } = await supabase
        .from('integration_branch_mappings')
        .select('branch_id')
        .eq('organization_id', job.organization_id)
        .eq('connected_account_id', connection.id)
        .eq('branch_id', job.branch_id)
        .eq('external_resource_type', 'CONNECTION_SCOPE')
        .is('deleted_at', null)
        .maybeSingle();
      if (mappingError) throw mappingError;
      if (!mapping) continue;
    }
    const { data: secret, error: secretError } = await supabase
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', job.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (secretError || !secret) throw secretError ?? new Error('GROQ_CREDENTIAL_NOT_CONFIGURED');
    return {
      apiKey: (await decryptCredential<GroqCredential>(secret.encrypted_payload)).api_key,
      transcriptionModel: config.models.transcription_model,
      analysisModel: config.models.analysis_model,
      billingMode: 'TENANT_CONNECTION',
      transcriptionCredits: configuredCredits('AI_CALL_TRANSCRIPTION_CREDITS'),
      analysisCredits: configuredCredits('AI_CALL_ANALYSIS_CREDITS'),
    };
  }
  return null;
}

async function platformGroq() {
  return {
    apiKey: requiredEnvironment('GROQ_API_KEY'),
    transcriptionModel: requiredEnvironment('GROQ_TRANSCRIPTION_MODEL'),
    analysisModel: requiredEnvironment('GROQ_ANALYSIS_MODEL'),
    billingMode: 'PLATFORM_CREDITS',
    transcriptionCredits: configuredCredits('AI_CALL_TRANSCRIPTION_CREDITS'),
    analysisCredits: configuredCredits('AI_CALL_ANALYSIS_CREDITS'),
  };
}

async function transcribe(input: { apiKey: string; model: string; audioUrl: string }) {
  const form = new FormData();
  form.set('url', input.audioUrl);
  form.set('model', input.model);
  form.set('response_format', 'verbose_json');
  form.set('timestamp_granularities[]', 'segment');
  form.set('temperature', '0');
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(4 * 60_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    text?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  } | null;
  if (!response.ok || !payload?.text?.trim())
    throw new Error(
      response.status === 429 ? 'GROQ_TRANSCRIPTION_RATE_LIMITED' : 'GROQ_TRANSCRIPTION_FAILED',
    );
  return {
    text: payload.text.trim(),
    segments: (payload.segments ?? []).flatMap((segment) =>
      typeof segment.text === 'string' && segment.text.trim()
        ? [{ start: segment.start ?? null, end: segment.end ?? null, text: segment.text.trim() }]
        : [],
    ),
  };
}

async function analyze(input: { apiKey: string; model: string; transcript: string }) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You review automobile dealership call transcripts. Return JSON only with normalized_transcript, speaker_turns, summary, and fields. speaker_turns is an ordered array of {speaker:"AGENT"|"CUSTOMER"|"UNKNOWN",text:string}; keep user 1 (dealership agent) and user 2 (customer) separate and never merge or swap their statements. If a mixed mono recording makes identity uncertain, use UNKNOWN instead of guessing. Preserve uncertain wording rather than inventing details. fields may include customer_name, phone, email, interested_model, lifecycle_status, temperature, next_followup_at, and lost_reason only when directly supported by the call. Only suggest lost_reason when the customer clearly gives a reason and lifecycle_status is Lost. next_followup_at must be ISO 8601 or null. All fields are suggestions requiring human approval.',
        },
        { role: 'user', content: input.transcript.slice(0, 100_000) },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (!response.ok || !content)
    throw new Error(
      response.status === 429 ? 'GROQ_ANALYSIS_RATE_LIMITED' : 'GROQ_ANALYSIS_FAILED',
    );
  const parsed = JSON.parse(content) as {
    normalized_transcript?: unknown;
    summary?: unknown;
    fields?: unknown;
    speaker_turns?: unknown;
  };
  const normalizedTranscript =
    typeof parsed.normalized_transcript === 'string' && parsed.normalized_transcript.trim()
      ? parsed.normalized_transcript.trim()
      : input.transcript;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 12_000) : '';
  const candidateFields =
    parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
      ? (parsed.fields as Record<string, unknown>)
      : {};
  const fields: Record<string, unknown> = {};
  const boundedTextFields = new Map([
    ['customer_name', 200],
    ['phone', 40],
    ['email', 320],
    ['interested_model', 200],
    ['lost_reason', 500],
  ]);
  for (const [key, maximum] of boundedTextFields) {
    const value = candidateFields[key];
    if (typeof value === 'string' && value.trim()) fields[key] = value.trim().slice(0, maximum);
  }
  if (
    typeof candidateFields.lifecycle_status === 'string' &&
    [
      'New',
      'Contacted',
      'Qualified',
      'Appointment Scheduled',
      'Transferred to Sales',
      'Lost',
    ].includes(candidateFields.lifecycle_status)
  )
    fields.lifecycle_status = candidateFields.lifecycle_status;
  if (
    typeof candidateFields.temperature === 'string' &&
    ['HOT', 'WARM', 'COLD', 'DORMANT'].includes(candidateFields.temperature)
  )
    fields.temperature = candidateFields.temperature;
  if (
    typeof candidateFields.next_followup_at === 'string' &&
    Number.isFinite(Date.parse(candidateFields.next_followup_at))
  )
    fields.next_followup_at = new Date(candidateFields.next_followup_at).toISOString();
  if (fields.lost_reason && fields.lifecycle_status !== 'Lost') delete fields.lost_reason;
  const speakerTurns = Array.isArray(parsed.speaker_turns)
    ? parsed.speaker_turns.flatMap((turn) => {
        if (!turn || typeof turn !== 'object') return [];
        const record = turn as { speaker?: unknown; text?: unknown };
        const speaker =
          record.speaker === 'AGENT' || record.speaker === 'CUSTOMER' ? record.speaker : 'UNKNOWN';
        return typeof record.text === 'string' && record.text.trim()
          ? [{ speaker, text: record.text.trim().slice(0, 12000) }]
          : [];
      })
    : [];
  return { normalizedTranscript, summary, fields, speakerTurns };
}

async function reserveCredits(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  amount: number,
  feature: string,
  referenceId: string,
) {
  const reservation = await supabase.rpc('reserve_ai_credits', {
    target_organization_id: organizationId,
    target_amount: amount,
    target_feature: feature,
    target_reference_id: referenceId,
  });
  if (reservation.error || !reservation.data)
    throw new Error(
      reservation.error?.message.includes('INSUFFICIENT_CREDITS')
        ? 'INSUFFICIENT_CREDITS'
        : 'AI_CREDIT_RESERVATION_FAILED',
    );
  return reservation.data as string;
}

async function commitCredits(supabase: ReturnType<typeof createClient>, reservationId: string) {
  const result = await supabase.rpc('commit_ai_credit_reservation', {
    target_reservation_id: reservationId,
  });
  if (result.error || !result.data) throw new Error('AI_CREDIT_COMMIT_FAILED');
}

async function processJob(supabase: ReturnType<typeof createClient>, storage: S3Client, job: Job) {
  const tenantProvider = await findTenantGroq(supabase, job);
  const provider = tenantProvider ?? (await platformGroq());
  const { data: existingTranscript, error: existingError } = await supabase
    .from('call_transcripts')
    .select('id,raw_transcript_text,transcript_text,status')
    .eq('organization_id', job.organization_id)
    .eq('processing_job_id', job.id)
    .maybeSingle();
  if (existingError) throw existingError;
  let rawTranscript =
    existingTranscript?.raw_transcript_text ?? existingTranscript?.transcript_text ?? null;
  const transcriptionReference = `ai-call:${job.id}:${job.recording_id}:transcription`;
  const analysisReference = `ai-call:${job.id}:${job.recording_id}:analysis`;
  const transcriptionReservation = await reserveCredits(
    supabase,
    job.organization_id,
    provider.transcriptionCredits,
    'call_transcription',
    transcriptionReference,
  );
  if (!rawTranscript) {
    const audioUrl = await getSignedUrl(
      storage,
      new GetObjectCommand({ Bucket: job.object_bucket, Key: job.object_key }),
      { expiresIn: 600 },
    );
    const transcription = await transcribe({
      apiKey: provider.apiKey,
      model: provider.transcriptionModel,
      audioUrl,
    });
    rawTranscript = transcription.text;
    const saved = await supabase.rpc('save_ai_call_transcription', {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_raw_transcript: rawTranscript,
      target_provider_reference: `groq:${provider.transcriptionModel}`,
    });
    if (saved.error || !saved.data) throw new Error('AI_TRANSCRIPTION_SAVE_FAILED');
  }
  await commitCredits(supabase, transcriptionReservation);
  const analysisReservation = await reserveCredits(
    supabase,
    job.organization_id,
    provider.analysisCredits,
    'call_summary_and_extraction',
    analysisReference,
  );
  if (existingTranscript?.status === 'COMPLETED') {
    await commitCredits(supabase, analysisReservation);
  } else {
    const analysis = await analyze({
      apiKey: provider.apiKey,
      model: provider.analysisModel,
      transcript: rawTranscript,
    });
    const saved = await supabase.rpc('save_ai_call_analysis_result', {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_normalized_transcript: analysis.normalizedTranscript,
      target_speaker_turns: analysis.speakerTurns,
      target_separation_method: 'AI_INFERRED_OR_UNKNOWN',
      target_summary: analysis.summary,
      target_suggestions: analysis.fields,
      target_analysis_model_reference: provider.analysisModel,
    });
    if (saved.error || !saved.data) throw new Error('AI_ANALYSIS_SAVE_FAILED');
    await commitCredits(supabase, analysisReservation);
  }
  const { data: completed, error: completeError } = await supabase.rpc(
    'complete_ai_call_processing_job',
    {
      target_job_id: job.id,
      target_lease_token: job.lease_token,
      target_billing_mode: provider.billingMode,
      target_credits_consumed: provider.transcriptionCredits + provider.analysisCredits,
    },
  );
  if (completeError || !completed)
    throw completeError ?? new Error('AI_CALL_PROCESSING_LEASE_LOST');
}

export const aiCallProcessing = schedules.task({
  id: 'ai-call-processing',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 2 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase.rpc<Job[]>('claim_ai_call_processing_jobs', {
      target_worker_id: `trigger:ai-call-processing:${crypto.randomUUID()}`,
      target_batch_size: 2,
    });
    if (error) throw error;
    const storage = storageClient();
    let completed = 0;
    let retried = 0;
    for (const job of data ?? []) {
      try {
        await processJob(supabase, storage, job);
        completed += 1;
      } catch (error) {
        const safeCode =
          error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)
            ? error.message
            : 'AI_CALL_PROCESSING_RETRY';
        const { error: retryError } = await supabase.rpc('retry_ai_call_processing_job', {
          target_job_id: job.id,
          target_lease_token: job.lease_token,
          target_safe_error_code: safeCode,
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { claimed: data?.length ?? 0, completed, retried };
  },
});
