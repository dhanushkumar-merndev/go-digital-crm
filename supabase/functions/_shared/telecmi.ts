export type TelecmiCredential = {
  app_id: number;
  app_secret: string;
  default_user_id: string;
  caller_id: string | null;
  webhook_secret: string;
};

const TELECMI_API_BASE = 'https://rest.telecmi.com';

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
  const response = await fetch(`${TELECMI_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as
    (T & { code?: number; error?: boolean; msg?: string }) | null;
  if (!response.ok || !payload || payload.code !== 200 || payload.error)
    throw new Error(`TELECMI_REQUEST_REJECTED_${response.status}`);
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
