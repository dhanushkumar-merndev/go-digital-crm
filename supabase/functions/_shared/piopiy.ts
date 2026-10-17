// TeleCMI PIOPIY adapter for keypad auto calls (PCMO).
//
// Verified against TeleCMI's own SDK (github.com/telecmi/piopiy_node, 2026-10-14):
//   POST https://rest.piopiy.com/v3/voice/pcmo/call  (Bearer token)
//   body { caller_id, to_number, app_id, pipeline: [...actions], options, variables }
//   play_get_input { prompt: {type:'say', say, language, voice_id, speed} |
//                            {type:'file', file_name}, input:['dtmf'],
//                    dtmf:{max_digits, first_digit_timeout}, retries:{max},
//                    on_result:{type:'url', url} }
//   play { file_name }, hangup {}
// Not documented publicly: what PIOPIY sends to `on_result.url`, the response it
// expects (we answer with the next action list), and the call-status callback.
// Those shapes are read tolerantly here and nowhere else, so confirming them
// with TeleCMI changes only this file.
//
// AI agent calls (piopiy_node src/voice/ai_agent.js, checked 2026-10-17):
//   POST https://rest.piopiy.com/v3/voice/ai/call  (Bearer token)
//   body { caller_id, to_number, agent_id, options, variables }
// PIOPIY rings the customer and, once answered, hands the call to whichever
// process is connected as `agent_id` (our services/voice-agent), passing the
// variables along as the session metadata.

export type PiopiyCredential = {
  token: string;
  app_id: string;
  caller_id: string;
  webhook_secret: string;
};

export type AutoIvrPrompt = {
  text?: string | null;
  language?: string | null;
  voice_id?: string | null;
  audio_file_id?: string | null;
};

export type AutoIvrNode = {
  title: string;
  prompt: AutoIvrPrompt;
  timeout_sec: number;
  retries: number;
  on_no_input: string;
  options: Array<{ key: string; label: string; next: string }>;
};

export type PiopiyVoiceDefaults = { language: string; voice_id: string; speed: number };

export type PcmoPrompt =
  | { type: 'say'; say: string; language: string; voice_id: string; speed: number }
  | { type: 'file'; file_name: string };

export type PcmoAction =
  | {
      action: 'play_get_input';
      prompt: PcmoPrompt;
      input: ['dtmf'];
      dtmf: { max_digits: number; first_digit_timeout: number };
      retries: { max: number };
      on_result: { type: 'url'; url: string };
    }
  | { action: 'play'; file_name: string }
  | { action: 'hangup' };

const PIOPIY_API = 'https://rest.piopiy.com/v3';
const PHONE_PATTERN = /^[1-9][0-9]{6,15}$/;

export class PiopiyError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly pauseDialer: boolean,
  ) {
    super(code);
    this.name = 'PiopiyError';
  }
}

/** Digits with country code, as PIOPIY expects. A 10-digit Indian mobile gets 91. */
export function piopiyNumber(value: string) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (!PHONE_PATTERN.test(digits)) throw new PiopiyError('PIOPIY_NUMBER_INVALID', false, false);
  return digits;
}

export function defaultVoice(
  config: Record<string, unknown> | null | undefined,
): PiopiyVoiceDefaults {
  const language = typeof config?.default_language === 'string' ? config.default_language : '';
  const voice = typeof config?.default_voice_id === 'string' ? config.default_voice_id : '';
  return { language: language || 'en-IN', voice_id: voice || 'female', speed: 1 };
}

/** A recording wins over text-to-speech when the prompt has one. */
export function pcmoPrompt(
  prompt: AutoIvrPrompt,
  defaults: PiopiyVoiceDefaults,
  audioUrl: string | null,
  prefixText?: string | null,
): PcmoPrompt {
  if (audioUrl) return { type: 'file', file_name: audioUrl };
  const say = [prefixText?.trim(), prompt.text?.trim()].filter(Boolean).join(' ');
  return {
    type: 'say',
    say: say.slice(0, 900),
    language: prompt.language?.trim() || defaults.language,
    voice_id: prompt.voice_id?.trim() || defaults.voice_id,
    speed: defaults.speed,
  };
}

/**
 * One question. We handle repeats ourselves (the result URL carries the
 * attempt), so PIOPIY is asked for a single try and must report silence too.
 */
export function questionAction(
  node: AutoIvrNode,
  prompt: PcmoPrompt,
  resultUrl: string,
): PcmoAction {
  return {
    action: 'play_get_input',
    prompt,
    input: ['dtmf'],
    dtmf: { max_digits: 1, first_digit_timeout: Math.min(Math.max(node.timeout_sec, 3), 15) },
    retries: { max: 0 },
    on_result: { type: 'url', url: resultUrl },
  };
}

/**
 * PCMO `play` only takes a file, so a spoken goodbye is a one-second
 * play_get_input whose result is a hangup.
 */
export function goodbyeActions(prompt: PcmoPrompt, hangupUrl: string): PcmoAction[] {
  if (prompt.type === 'file')
    return [{ action: 'play', file_name: prompt.file_name }, { action: 'hangup' }];
  return [
    {
      action: 'play_get_input',
      prompt,
      input: ['dtmf'],
      dtmf: { max_digits: 1, first_digit_timeout: 1 },
      retries: { max: 0 },
      on_result: { type: 'url', url: hangupUrl },
    },
  ];
}

function classify(status: number): PiopiyError {
  if (status === 401 || status === 403 || status === 420)
    return new PiopiyError('PIOPIY_AUTH_FAILED', false, true);
  if (status === 402) return new PiopiyError('PIOPIY_BALANCE_LOW', false, true);
  if (status === 429) return new PiopiyError('PIOPIY_RATE_LIMITED', true, false);
  if (status >= 500) return new PiopiyError('PIOPIY_UNAVAILABLE', true, false);
  return new PiopiyError('PIOPIY_REQUEST_REJECTED', false, false);
}

function providerCallId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['call_id', 'callId', 'uuid', 'request_id', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() && value.length <= 255) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  for (const key of ['data', 'result']) {
    const nested = providerCallId(record[key]);
    if (nested) return nested;
  }
  return null;
}

async function postCall(
  credential: PiopiyCredential,
  path: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${PIOPIY_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof PiopiyError) throw error;
    throw new PiopiyError('PIOPIY_UNREACHABLE', true, false);
  }
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) throw classify(response.status);
  const callId = providerCallId(responseBody);
  if (!callId) throw new PiopiyError('PIOPIY_RESPONSE_MALFORMED', false, false);
  return callId;
}

/** Starts the outbound call and returns PIOPIY's call id. */
export async function startPiopiyPcmoCall(
  credential: PiopiyCredential,
  input: {
    toNumber: string;
    pipeline: PcmoAction[];
    ringTimeoutSec: number;
    maxDurationSec: number;
    variables: Record<string, string | number | boolean>;
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return postCall(
    credential,
    '/voice/pcmo/call',
    {
      caller_id: piopiyNumber(credential.caller_id),
      to_number: piopiyNumber(input.toNumber),
      app_id: credential.app_id,
      pipeline: input.pipeline,
      options: {
        max_duration_sec: input.maxDurationSec,
        ring_timeout_sec: input.ringTimeoutSec,
        record: true,
      },
      variables: input.variables,
    },
    fetcher,
  );
}

/**
 * Starts an AI agent call and returns PIOPIY's call id. `variables` reach the
 * agent as session metadata, so they carry only the CRM call id and its
 * context token, never customer details.
 */
export async function startPiopiyAiCall(
  credential: PiopiyCredential,
  input: {
    agentId: string;
    toNumber: string;
    ringTimeoutSec: number;
    maxDurationSec: number;
    variables: { crm_call_id: string; context_token: string };
  },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(input.agentId))
    throw new PiopiyError('AI_AGENT_NOT_CONFIGURED', false, true);
  return postCall(
    credential,
    '/voice/ai/call',
    {
      caller_id: piopiyNumber(credential.caller_id),
      to_number: piopiyNumber(input.toNumber),
      agent_id: input.agentId,
      options: {
        max_duration_sec: input.maxDurationSec,
        ring_timeout_sec: input.ringTimeoutSec,
        record: true,
      },
      variables: input.variables,
    },
    fetcher,
  );
}

/** The key the customer pressed, wherever PIOPIY put it; null for silence. */
export function pressedKey(payload: Record<string, unknown>): string | null {
  const candidates = ['digits', 'dtmf', 'input', 'result', 'value', 'key', 'Digits'];
  for (const name of candidates) {
    const value = payload[name];
    if (typeof value === 'number') return String(value).slice(0, 1);
    if (typeof value === 'string' && /[0-9*#]/.test(value)) return value.match(/[0-9*#]/)![0];
    if (value && typeof value === 'object') {
      const nested = pressedKey(value as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  const data = payload.data;
  if (data && typeof data === 'object') return pressedKey(data as Record<string, unknown>);
  return null;
}

export type PiopiyCallEvent = {
  callId: string | null;
  status: string | null;
  terminal: boolean;
  durationSeconds: number | null;
  recordingUrl: string | null;
  recordingRef: string | null;
};

const TERMINAL = new Set([
  'COMPLETED',
  'COMPLETE',
  'ENDED',
  'END',
  'HANGUP',
  'DISCONNECTED',
  'NO_ANSWER',
  'NOANSWER',
  'NO-ANSWER',
  'BUSY',
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'REJECTED',
  'MISSED',
  'CDR',
]);

function firstString(payload: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** Normalizes a PIOPIY call-status / CDR callback. */
export function piopiyCallEvent(raw: Record<string, unknown>): PiopiyCallEvent {
  const payload =
    raw.data && typeof raw.data === 'object' ? { ...raw, ...(raw.data as object) } : raw;
  const record = payload as Record<string, unknown>;
  const callId = firstString(record, ['call_id', 'callId', 'uuid', 'request_id', 'cmiuuid']);
  const status = firstString(record, ['status', 'call_status', 'event', 'type', 'state']);
  const normalized = status?.toUpperCase().replace(/\s+/g, '_') ?? null;
  const durationText = firstString(record, ['duration', 'billsec', 'answered_sec', 'talk_time']);
  const duration = durationText && /^\d+$/.test(durationText) ? Number(durationText) : null;
  const recording = firstString(record, ['recording_url', 'record_url', 'recording', 'record']);
  const recordingUrl = recording && /^https:\/\//i.test(recording) ? recording : null;
  const fileName = firstString(record, ['filename', 'file_name', 'recording_file']);
  return {
    callId,
    status: normalized,
    terminal:
      normalized !== null &&
      (TERMINAL.has(normalized) ||
        (duration !== null && Boolean(firstString(record, ['end_time', 'endtime'])))),
    durationSeconds: duration,
    recordingUrl,
    recordingRef: recordingUrl ?? fileName,
  };
}
