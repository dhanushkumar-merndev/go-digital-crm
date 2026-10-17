import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { decryptJson } from './crypto.ts';
import {
  defaultVoice,
  goodbyeActions,
  type AutoIvrNode,
  type AutoIvrPrompt,
  type PcmoAction,
  PiopiyError,
  type PiopiyCredential,
  type PiopiyVoiceDefaults,
  pcmoPrompt,
  questionAction,
  startPiopiyAiCall,
  startPiopiyPcmoCall,
} from './piopiy.ts';
import { serviceClient } from './supabase.ts';
import { tigrisClient } from './tigris.ts';

type Admin = ReturnType<typeof serviceClient>;

export type PiopiyConnection = {
  id: string;
  organizationId: string;
  credential: PiopiyCredential;
  voice: PiopiyVoiceDefaults;
  /** The PIOPIY agent our voice-agent service connects as; the platform one by default. */
  agentId: string | null;
};

export async function loadPiopiyConnection(
  admin: Admin,
  connectionId: string,
): Promise<PiopiyConnection | null> {
  const { data: connection } = await admin
    .from('connected_accounts')
    .select('id, organization_id, connection_config')
    .eq('id', connectionId)
    .eq('provider_key', 'telecmi_piopiy')
    .eq('status', 'CONNECTED')
    .is('deleted_at', null)
    .maybeSingle();
  if (!connection) return null;
  const { data: secret } = await admin
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', connection.organization_id)
    .eq('connected_account_id', connection.id)
    .maybeSingle();
  if (!secret) return null;
  return {
    id: connection.id,
    organizationId: connection.organization_id,
    credential: await decryptJson<PiopiyCredential>(secret.encrypted_payload),
    voice: defaultVoice(connection.connection_config as Record<string, unknown> | null),
    agentId: aiAgentId(connection.connection_config as Record<string, unknown> | null),
  };
}

function aiAgentId(config: Record<string, unknown> | null) {
  const configured = typeof config?.agent_id === 'string' ? config.agent_id.trim() : '';
  return configured || Deno.env.get('PIOPIY_AI_AGENT_ID')?.trim() || null;
}

function edgeBase() {
  const base = Deno.env.get('PUBLIC_EDGE_FUNCTION_BASE_URL')?.replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING');
  return base;
}

/** Where PIOPIY reports a keypress for one question of one call. */
export function answerUrl(
  connection: PiopiyConnection,
  callId: string,
  nodeId: string,
  attempt: number,
) {
  const query = new URLSearchParams({
    connection_id: connection.id,
    token: connection.credential.webhook_secret,
    call: callId,
    node: nodeId,
    attempt: String(attempt),
  });
  return `${edgeBase()}/provider-ivr-piopiy?${query}`;
}

export function hangupUrl(connection: PiopiyConnection, callId: string) {
  const query = new URLSearchParams({
    connection_id: connection.id,
    token: connection.credential.webhook_secret,
    call: callId,
    stage: 'hangup',
  });
  return `${edgeBase()}/provider-ivr-piopiy?${query}`;
}

/**
 * A short-lived URL PIOPIY can fetch an uploaded prompt recording from. It is
 * built per call and never stored.
 */
export async function promptAudioUrl(
  admin: Admin,
  organizationId: string,
  prompt: AutoIvrPrompt | null | undefined,
): Promise<string | null> {
  if (!prompt?.audio_file_id) return null;
  const { data } = await admin.rpc('get_auto_ivr_prompt_object', {
    target_organization_id: organizationId,
    target_object_file_id: prompt.audio_file_id,
  });
  const object = data as { bucket?: string; object_key?: string } | null;
  if (!object?.bucket || !object.object_key) return null;
  return getSignedUrl(
    tigrisClient(),
    new GetObjectCommand({ Bucket: object.bucket, Key: object.object_key }),
    { expiresIn: 15 * 60 },
  );
}

export async function questionActions(
  admin: Admin,
  connection: PiopiyConnection,
  callId: string,
  nodeId: string,
  node: AutoIvrNode,
  attempt: number,
  prefix?: string | null,
): Promise<PcmoAction[]> {
  const audio = await promptAudioUrl(admin, connection.organizationId, node.prompt);
  return [
    questionAction(
      node,
      pcmoPrompt(node.prompt, connection.voice, audio, audio ? null : prefix),
      answerUrl(connection, callId, nodeId, attempt),
    ),
  ];
}

export async function endActions(
  admin: Admin,
  connection: PiopiyConnection,
  callId: string,
  goodbye: AutoIvrPrompt | null | undefined,
): Promise<PcmoAction[]> {
  if (!goodbye) return [{ action: 'hangup' }];
  const audio = await promptAudioUrl(admin, connection.organizationId, goodbye);
  return goodbyeActions(
    pcmoPrompt(goodbye, connection.voice, audio),
    hangupUrl(connection, callId),
  );
}

type ClaimedJobBase = {
  job_id: string;
  lease_token: string;
  organization_id: string;
  call_id: string;
  lead_id: string;
  connection_id: string;
  to_number: string;
  customer_name: string | null;
  ring_timeout_sec: number;
  max_duration_sec: number;
};

type ClaimedJob =
  | (ClaimedJobBase & {
      mode: 'KEYPAD_IVR';
      start_node_id: string;
      start_node: AutoIvrNode;
      greeting: AutoIvrPrompt | null;
    })
  | (ClaimedJobBase & { mode: 'AI_AGENT'; context_token: string; language: string });

async function keypadCall(
  admin: Admin,
  connection: PiopiyConnection,
  job: Extract<ClaimedJob, { mode: 'KEYPAD_IVR' }>,
) {
  const pipeline: PcmoAction[] = [];
  const greetingAudio = await promptAudioUrl(admin, job.organization_id, job.greeting);
  if (greetingAudio) pipeline.push({ action: 'play', file_name: greetingAudio });
  // A spoken greeting is read out before the first question in one prompt.
  const greetingText = greetingAudio ? null : (job.greeting?.text ?? null);
  pipeline.push(
    ...(await questionActions(
      admin,
      connection,
      job.call_id,
      job.start_node_id,
      job.start_node,
      1,
      greetingText,
    )),
  );
  return startPiopiyPcmoCall(connection.credential, {
    toNumber: job.to_number,
    pipeline,
    ringTimeoutSec: job.ring_timeout_sec,
    maxDurationSec: job.max_duration_sec,
    variables: { crm_call_id: job.call_id, crm_lead_id: job.lead_id },
  });
}

/**
 * Claims the next lead for every idle telecaller with Auto call on and dials
 * it. Runs from the minute dispatch and again whenever a call ends, so the
 * queue moves on without waiting for the next minute.
 */
export async function dialNextAutoCalls(admin: Admin, workerId: string, batchSize = 5) {
  const { data, error } = await admin.rpc('claim_auto_call_jobs', {
    target_worker_id: workerId,
    target_batch_size: batchSize,
  });
  if (error) throw error;
  const jobs = (Array.isArray(data) ? data : []) as ClaimedJob[];
  const connections = new Map<string, PiopiyConnection | null>();
  const results: Array<{ job_id: string; ok: boolean; code?: string }> = [];

  for (const job of jobs) {
    try {
      if (!connections.has(job.connection_id))
        connections.set(job.connection_id, await loadPiopiyConnection(admin, job.connection_id));
      const connection = connections.get(job.connection_id);
      if (!connection) throw new PiopiyError('PIOPIY_NOT_CONNECTED', false, true);

      const providerCallId =
        job.mode === 'AI_AGENT'
          ? await startPiopiyAiCall(connection.credential, {
              agentId: connection.agentId ?? '',
              toNumber: job.to_number,
              ringTimeoutSec: job.ring_timeout_sec,
              maxDurationSec: job.max_duration_sec,
              variables: { crm_call_id: job.call_id, context_token: job.context_token },
            })
          : await keypadCall(admin, connection, job);
      const { error: markError } = await admin.rpc('mark_auto_call_dispatched', {
        target_job_id: job.job_id,
        target_lease_token: job.lease_token,
        target_provider_call_id: providerCallId,
      });
      if (markError) throw markError;
      results.push({ job_id: job.job_id, ok: true });
    } catch (error) {
      const piopiy = error instanceof PiopiyError ? error : null;
      const code = piopiy?.code ?? 'AUTO_CALL_DISPATCH_FAILED';
      await admin.rpc('fail_auto_call_dispatch', {
        target_job_id: job.job_id,
        target_lease_token: job.lease_token,
        target_error_code: code,
        target_pause_dialer: piopiy?.pauseDialer ?? false,
      });
      results.push({ job_id: job.job_id, ok: false, code });
    }
  }
  return { claimed: jobs.length, results };
}
