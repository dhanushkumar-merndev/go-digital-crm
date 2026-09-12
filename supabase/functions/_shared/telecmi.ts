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
  | 'TELECMI_REQUEST_REJECTED';

// TeleCMI answers every documented endpoint with HTTP 200 and an in-body `code`,
// so the body decides the outcome far more often than the transport status.
export class TelecmiError extends Error {
  readonly code: TelecmiFailureCode;
  readonly httpStatus: number | null;
  readonly providerCode: number | null;

  constructor(
    code: TelecmiFailureCode,
    options: { httpStatus?: number | null; providerCode?: number | null } = {},
  ) {
    super(code);
    this.name = 'TelecmiError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode ?? null;
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
  if (httpStatus === 401 || httpStatus === 403 || providerCode === 401 || providerCode === 403)
    return 'TELECMI_AUTH_REJECTED';
  return 'TELECMI_REQUEST_REJECTED';
}

export function normalizeTelecmiPhone(value: string) {
  const digits = value.replace(/\D/g, '');
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
      { httpStatus: response.status, providerCode: payload?.code ?? null },
    );
  return payload;
}

export async function testTelecmiCredential(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
) {
  await telecmiJson<{ total?: number; answered?: number; missed?: number }>('/v2/analysis', {
    appid: credential.app_id,
    secret: credential.app_secret,
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

export async function createTelecmiClickToCall(input: {
  credential: TelecmiCredential;
  userId?: string;
  customerPhone: string;
  callId: string;
  leadId: string;
}) {
  const result = await telecmiJson<{ request_id: string; msg: string }>('/v2/webrtc/click2call', {
    user_id: normalizeTelecmiUserId(input.userId ?? input.credential.default_user_id),
    secret: input.credential.app_secret,
    to: Number(normalizeTelecmiPhone(input.customerPhone)),
    extra_params: {
      crm: true,
      crm_call_id: input.callId,
      crm_lead_id: input.leadId,
    },
    // The website starts the call, then TeleCMI rings the mapped agent's
    // registered device before bridging the customer.
    webrtc: false,
    followme: true,
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
  // TeleCMI issues three-digit extensions and derives the agent id from them.
  if (!/^\d{3}$/.test(digits)) throw new Error('TELECMI_EXTENSION_INVALID');
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
  const result = await telecmiJson<{ agent_id?: string; msg?: string }>('/v2/user/add', {
    appid: input.credential.app_id,
    secret: input.credential.app_secret,
    extension,
    name: input.name.trim(),
    phone_number: phone,
    password: input.password,
  });
  // TeleCMI composes the agent id as `extension_appid`; deriving it locally when
  // the response omits it keeps the saved mapping usable either way.
  const agentId = result.agent_id?.trim() || `${extension}_${input.credential.app_id}`;
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
        message:
          'That extension is already in use in TeleCMI. Choose a different three-digit extension.',
        status: 409,
      };
    default:
      return {
        code: error.code,
        message: 'TeleCMI rejected the request.',
        status: 502,
      };
  }
}
