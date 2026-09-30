export type TelecmiCredential = {
  app_id: number;
  app_secret: string;
  default_user_id: string;
  caller_id: string | null;
  webhook_secret: string;
};

const TELECMI_API_BASE = 'https://rest.telecmi.com';

export type TelecmiFailureCode =
  | 'TELECMI_UNREACHABLE'
  | 'TELECMI_AUTH_REJECTED'
  | 'TELECMI_IP_NOT_ALLOWED'
  | 'TELECMI_INSUFFICIENT_BALANCE'
  | 'TELECMI_EXTENSION_TAKEN'
  | 'TELECMI_USER_LIMIT_REACHED'
  | 'TELECMI_REQUEST_REJECTED';

// TeleCMI answers every documented endpoint with HTTP 200 and an in-body `code`,
// so the body decides the outcome far more often than the transport status.
export class TelecmiError extends Error {
  readonly code: TelecmiFailureCode;
  readonly httpStatus: number | null;
  readonly providerCode: number | null;
  readonly providerMessage: string | null;

  constructor(
    code: TelecmiFailureCode,
    options: {
      httpStatus?: number | null;
      providerCode?: number | null;
      providerMessage?: string | null;
    } = {},
  ) {
    super(code);
    this.name = 'TelecmiError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode ?? null;
    this.providerMessage = options.providerMessage ?? null;
  }
}

// TeleCMI does not document an IP-allowlist rejection shape, so this classifies
// on the signals it does return and falls back to the generic code. Never widen
// this into a claim that a specific message proves an allowlist block.
function classifyTelecmiFailure(
  httpStatus: number,
  providerCode: number | null,
  message: string,
): TelecmiFailureCode {
  const normalized = message.toLowerCase();
  if (/\bip\b|whitelist|white-list|allowlist|not permitted from/.test(normalized))
    return 'TELECMI_IP_NOT_ALLOWED';
  if (/balance|insufficient|credit/.test(normalized)) return 'TELECMI_INSUFFICIENT_BALANCE';
  if (/extension .*(exist|taken|use)|already exist/.test(normalized))
    return 'TELECMI_EXTENSION_TAKEN';
  if (/user limit/.test(normalized)) return 'TELECMI_USER_LIMIT_REACHED';
  if (httpStatus === 401 || httpStatus === 403 || providerCode === 401 || providerCode === 403)
    return 'TELECMI_AUTH_REJECTED';
  return 'TELECMI_REQUEST_REJECTED';
}

// India is the CRM's default country, so a bare ten-digit mobile or one behind
// a trunk `0` gains `91` before it is dialled -- TeleCMI needs the country code
// and a telecaller typing ten digits is the normal case. A number that already
// carries a different country code is left alone; rewriting it would dial a
// stranger. This mirrors src/lib/phone.ts on the web side.
export function normalizeTelecmiPhone(value: string) {
  const raw = value.replace(/\D/g, '');
  const digits =
    raw.length === 10
      ? `91${raw}`
      : raw.length === 11 && raw.startsWith('0')
        ? `91${raw.slice(1)}`
        : raw;
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new Error('PHONE_NOT_INTERNATIONAL');
  return digits;
}

export function normalizeTelecmiUserId(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,12}_\d{1,12}$/.test(normalized)) throw new Error('TELECMI_USER_ID_INVALID');
  return normalized;
}

async function telecmiJson<T>(path: string, body: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetch(`${TELECMI_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A refused connection or a timeout is what an edge-blocked caller sees, so
    // it is reported separately from a credential rejection.
    throw new TelecmiError('TELECMI_UNREACHABLE');
  }
  const payload = (await response.json().catch(() => null)) as
    (T & { code?: number; error?: boolean; msg?: string }) | null;
  if (!response.ok || !payload || payload.code !== 200 || payload.error)
    throw new TelecmiError(
      classifyTelecmiFailure(response.status, payload?.code ?? null, payload?.msg ?? ''),
      {
        httpStatus: response.status,
        providerCode: payload?.code ?? null,
        providerMessage: payload?.msg ?? null,
      },
    );
  return payload;
}

export async function testTelecmiCredential(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
) {
  // /v2/analysis rejects a request that omits the window, so the credential
  // probe asks for a narrow recent one. The counts are discarded -- reaching a
  // 200 at all is the only signal this needs.
  const endDate = Date.now();
  const startDate = endDate - 86_400_000;
  await telecmiJson<{ total?: number; answered?: number; missed?: number }>('/v2/analysis', {
    appid: credential.app_id,
    secret: credential.app_secret,
    start_date: startDate,
    end_date: endDate,
  });
}

export async function configureTelecmiStereoStream(input: {
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>;
  enabled: boolean;
  websocketUrl?: string;
}) {
  return telecmiJson<{ msg: string }>('/v3/setting/stream', {
    appid: input.credential.app_id,
    secret: input.credential.app_secret,
    enable: input.enabled,
    ...(input.enabled
      ? {
          ws_url: input.websocketUrl,
          listen_mode: 'both',
          audio_type: 'stereo',
          sample_rate: '16k',
          direction: 'both',
        }
      : {}),
  });
}

// Which device TeleCMI rings first. Follow-me is a per-app TeleCMI entitlement
// -- an account without it answers click2call with `420: Follow-me calls are
// not allowed for this app` -- so the mode belongs to the tenant's connection
// config, never hardcoded into this adapter.
export type TelecmiCallMode = 'WEBRTC' | 'FOLLOW_ME';

export const defaultTelecmiCallMode: TelecmiCallMode = 'WEBRTC';

export function parseTelecmiCallMode(value: unknown): TelecmiCallMode {
  return value === 'FOLLOW_ME' || value === 'WEBRTC' ? value : defaultTelecmiCallMode;
}

export async function createTelecmiClickToCall(input: {
  credential: TelecmiCredential;
  userId?: string;
  customerPhone: string;
  callId: string;
  leadId: string;
  callMode?: TelecmiCallMode;
}) {
  // WEBRTC rings the agent's logged-in TeleCMI client; FOLLOW_ME rings the
  // phone number registered against that agent in TeleCMI.
  const followMe = (input.callMode ?? defaultTelecmiCallMode) === 'FOLLOW_ME';
  const result = await telecmiJson<{ request_id: string; msg: string }>('/v2/webrtc/click2call', {
    user_id: normalizeTelecmiUserId(input.userId ?? input.credential.default_user_id),
    secret: input.credential.app_secret,
    to: Number(normalizeTelecmiPhone(input.customerPhone)),
    extra_params: {
      crm: true,
      crm_call_id: input.callId,
      crm_lead_id: input.leadId,
    },
    webrtc: !followMe,
    followme: followMe,
    ...(input.credential.caller_id
      ? { callerid: Number(normalizeTelecmiPhone(input.credential.caller_id)) }
      : {}),
  });
  if (!result.request_id?.trim()) throw new Error('TELECMI_REQUEST_ID_MISSING');
  return { providerRequestId: result.request_id.trim(), status: 'PENDING' };
}

export function telecmiRecordingUrl(input: {
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>;
  fileName: string;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(input.fileName))
    throw new Error('TELECMI_RECORDING_FILE_INVALID');
  const url = new URL(`${TELECMI_API_BASE}/v2/play`);
  url.searchParams.set('appid', String(input.credential.app_id));
  url.searchParams.set('secret', input.credential.app_secret);
  url.searchParams.set('file', input.fileName);
  return url.toString();
}

export function constantTimeEqual(left: string, right: string) {
  if (!left || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function normalizeTelecmiExtension(value: string | number) {
  const digits = String(value).trim();
  // TeleCMI's /v2/user/add rejects any extension above 999 ("must be less than
  // or equal to 999"), so the API path is limited to three digits even though
  // agents made in the TeleCMI dashboard can carry longer ones.
  if (!/^[1-9]\d{2}$/.test(digits)) throw new Error('TELECMI_EXTENSION_INVALID');
  return Number(digits);
}

export async function addTelecmiUser(input: {
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>;
  extension: string | number;
  name: string;
  phone: string;
  password: string;
}) {
  const extension = normalizeTelecmiExtension(input.extension);
  const phone = normalizeTelecmiPhone(input.phone);
  const result = await telecmiJson<{
    agent_id?: string;
    agent?: { agent_id?: string };
    msg?: string;
  }>('/v2/user/add', {
    appid: input.credential.app_id,
    secret: input.credential.app_secret,
    extension,
    name: input.name.trim(),
    phone_number: phone,
    password: input.password,
  });
  // TeleCMI composes the agent id as `extension_appid`; deriving it locally when
  // the response omits it keeps the saved mapping usable either way.
  // The live API nests the id under `agent`; older responses put it at the top.
  const agentId =
    result.agent?.agent_id?.trim() ||
    result.agent_id?.trim() ||
    `${extension}_${input.credential.app_id}`;
  return { userId: normalizeTelecmiUserId(agentId), extension, phone };
}

// Every TeleCMI-facing function reports the same vocabulary, so a Client Admin
// can tell an allowlist rejection apart from a wrong secret without a log dive.
export function describeTelecmiFailure(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (!(error instanceof TelecmiError))
    return {
      code: 'TELECMI_CONNECTION_FAILED',
      message: 'The TeleCMI request could not be completed.',
      status: 502,
    };
  switch (error.code) {
    case 'TELECMI_UNREACHABLE':
      return {
        code: error.code,
        message:
          'TeleCMI did not answer. If your TeleCMI account restricts API access by IP address, this server is not on that allowlist.',
        status: 504,
      };
    case 'TELECMI_IP_NOT_ALLOWED':
      return {
        code: error.code,
        message:
          'TeleCMI refused this server. Clear the IP allowlist on your TeleCMI account, or ask TeleCMI which addresses to allow.',
        status: 502,
      };
    case 'TELECMI_AUTH_REJECTED':
      return {
        code: error.code,
        message:
          'TeleCMI rejected the App ID or App Secret. Re-copy both from Developer → App Secret.',
        status: 502,
      };
    case 'TELECMI_INSUFFICIENT_BALANCE':
      return {
        code: error.code,
        message: 'TeleCMI reported an insufficient account balance.',
        status: 502,
      };
    case 'TELECMI_EXTENSION_TAKEN':
      return {
        code: error.code,
        message: 'That extension is already in use in TeleCMI. Choose a different extension.',
        status: 409,
      };
    case 'TELECMI_USER_LIMIT_REACHED':
      return {
        code: error.code,
        message:
          'Your TeleCMI plan has no free agent seats. Remove an agent in TeleCMI or upgrade the plan, then try again.',
        status: 409,
      };
    default:
      return {
        code: error.code,
        message: error.providerMessage
          ? `TeleCMI rejected the request. ${error.providerCode}: ${error.providerMessage}`
          : 'TeleCMI rejected the request.',
        status: 502,
      };
  }
}

export type TelecmiAgent = {
  agentId: string;
  name: string | null;
  extension: number | null;
  phone: string | null;
};

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// /v2/user/list pages at most 10 agents and reports the total as `count`, so
// the whole list is walked page by page. The page cap only stops a provider
// that keeps reporting a larger count from looping forever.
export async function listTelecmiAgents(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
): Promise<TelecmiAgent[]> {
  const agents: TelecmiAgent[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await telecmiJson<{ count?: number; agents?: Array<Record<string, unknown>> }>(
      '/v2/user/list',
      { appid: credential.app_id, secret: credential.app_secret, page, limit: 10 },
    );
    const rows = Array.isArray(result.agents) ? result.agents : [];
    for (const row of rows) {
      const agentId = optionalText(row.agent_id);
      if (!agentId) continue;
      agents.push({
        agentId,
        name: optionalText(row.name),
        extension: optionalNumber(row.extension),
        phone: optionalText(typeof row.phone === 'number' ? String(row.phone) : row.phone),
      });
    }
    const total = optionalNumber(result.count) ?? agents.length;
    if (rows.length < 10 || agents.length >= total) break;
  }
  return agents;
}

// /v2/balance is the only account-level data TeleCMI exposes: call balance, SMS
// balance and plan expiry. It does not report the plan's agent seat count.
export async function getTelecmiAccountBalance(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
) {
  const result = await telecmiJson<{ balance?: unknown; sms?: unknown; expire?: unknown }>(
    '/v2/balance',
    { appid: credential.app_id, secret: credential.app_secret },
  );
  const expire = optionalNumber(result.expire);
  return {
    balance: optionalNumber(result.balance),
    smsBalance: optionalNumber(result.sms),
    // Documented as a timestamp without a unit; the live API returns
    // milliseconds, but seconds are accepted too.
    expiresAt:
      expire && expire > 0
        ? new Date(expire > 1_000_000_000_000 ? expire : expire * 1000).toISOString()
        : null,
  };
}

export async function removeTelecmiUser(input: {
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>;
  userId: string;
}) {
  await telecmiJson('/v2/user/remove', {
    appid: input.credential.app_id,
    secret: input.credential.app_secret,
    id: normalizeTelecmiUserId(input.userId),
  });
}
