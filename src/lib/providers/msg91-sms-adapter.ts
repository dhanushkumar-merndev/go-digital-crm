/**
 * MSG91 template SMS (Flow API v5).
 *
 * India sends business SMS only through a DLT-registered template, so a drip
 * step never carries free text: it names the MSG91 template id and the values
 * for that template's variables (VAR1, VAR2 ... -- MSG91 matches them by name,
 * case-sensitively). The documented request is
 *
 *   POST https://control.msg91.com/api/v5/flow
 *   authkey: <tenant authkey>
 *   { "template_id", "short_url": "0", "recipients": [{ "mobiles", ...variables }] }
 *
 * and the response is `{ "type": "success", "message": "<request id>" }` or
 * `{ "type": "error", "message": "<reason>" }`. Errors are mapped to stable
 * codes; the provider's own text is never passed through.
 */

export type Msg91Credential = {
  authkey: string;
  sender_id?: string | null;
};

export type Msg91SmsInput = {
  credential: Msg91Credential;
  templateId: string;
  /** Any phone format; normalized to country code + number. */
  recipient: string;
  variables: Record<string, string>;
};

export type Msg91SmsErrorCode =
  | 'DRIP_SMS_RECIPIENT_INVALID'
  | 'DRIP_SMS_TEMPLATE_INVALID'
  | 'DRIP_SMS_AUTH_FAILED'
  | 'DRIP_SMS_IP_NOT_ALLOWED'
  | 'DRIP_SMS_RATE_LIMITED'
  | 'DRIP_SMS_PROVIDER_UNAVAILABLE'
  | 'DRIP_SMS_REJECTED';

export class Msg91SmsError extends Error {
  readonly code: Msg91SmsErrorCode;
  /** Worth retrying later: rate limits and provider outages. */
  readonly retryable: boolean;

  constructor(code: Msg91SmsErrorCode, retryable: boolean) {
    super(code);
    this.name = 'Msg91SmsError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';

/** 10-digit Indian mobiles gain the 91 prefix; anything else keeps its digits. */
export function normalizeMsg91Mobile(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '');
  const mobile = digits.length === 10 ? `91${digits}` : digits;
  if (mobile.length < 11 || mobile.length > 15) {
    throw new Msg91SmsError('DRIP_SMS_RECIPIENT_INVALID', false);
  }
  return mobile;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function sendMsg91TemplateSms(
  input: Msg91SmsInput,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const templateId = input.templateId.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(templateId)) {
    throw new Msg91SmsError('DRIP_SMS_TEMPLATE_INVALID', false);
  }
  const authkey = input.credential.authkey.trim();
  if (!authkey) throw new Msg91SmsError('DRIP_SMS_AUTH_FAILED', false);

  const recipient: Record<string, string> = { mobiles: normalizeMsg91Mobile(input.recipient) };
  for (const [key, value] of Object.entries(input.variables ?? {})) {
    if (/^[A-Za-z0-9_]{1,40}$/.test(key) && key !== 'mobiles') recipient[key] = String(value);
  }
  const body: Record<string, unknown> = {
    template_id: templateId,
    short_url: '0',
    recipients: [recipient],
  };
  const sender = input.credential.sender_id?.trim();
  if (sender) body.sender = sender;

  let response: Response;
  try {
    response = await fetcher(MSG91_FLOW_URL, {
      method: 'POST',
      headers: {
        authkey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Msg91SmsError('DRIP_SMS_PROVIDER_UNAVAILABLE', true);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Msg91SmsError('DRIP_SMS_AUTH_FAILED', false);
  }
  if (response.status === 418) throw new Msg91SmsError('DRIP_SMS_IP_NOT_ALLOWED', false);
  if (response.status === 429) throw new Msg91SmsError('DRIP_SMS_RATE_LIMITED', true);
  if (response.status >= 500) throw new Msg91SmsError('DRIP_SMS_PROVIDER_UNAVAILABLE', true);

  const payload = record(await response.json().catch(() => null));
  const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (response.ok && type === 'success' && message) return message;

  // MSG91 answers some failures with HTTP 200 and type "error".
  if (
    String(payload?.code) === '418' ||
    /whitelist|ip.*(?:blocked|allow)|(?:blocked|allow).*ip/i.test(message)
  )
    throw new Msg91SmsError('DRIP_SMS_IP_NOT_ALLOWED', false);
  if (/auth/i.test(message)) throw new Msg91SmsError('DRIP_SMS_AUTH_FAILED', false);
  if (/template|flow/i.test(message)) throw new Msg91SmsError('DRIP_SMS_TEMPLATE_INVALID', false);
  throw new Msg91SmsError('DRIP_SMS_REJECTED', false);
}
