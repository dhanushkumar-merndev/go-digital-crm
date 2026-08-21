export type TwilioVoiceCredential = {
  account_sid: string;
  api_key_sid: string;
  api_key_secret: string;
  auth_token: string;
  phone_number: string;
};

export function normalizedE164(value: string) {
  const normalized = value.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error('PHONE_NOT_E164');
  return normalized;
}

function basicAuthorization(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export async function createTwilioBridgeCall(input: {
  credential: TwilioVoiceCredential;
  consultantPhone: string;
  customerPhone: string;
  twiml: string;
  statusCallback: string;
}) {
  const body = new URLSearchParams({
    To: normalizedE164(input.consultantPhone),
    From: normalizedE164(input.credential.phone_number),
    Twiml: input.twiml,
    StatusCallback: input.statusCallback,
    StatusCallbackMethod: 'POST',
  });
  for (const event of ['initiated', 'ringing', 'answered', 'completed'])
    body.append('StatusCallbackEvent', event);
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.credential.account_sid)}/Calls.json`,
    {
      method: 'POST',
      headers: {
        authorization: basicAuthorization(
          input.credential.api_key_sid,
          input.credential.api_key_secret,
        ),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  const result = (await response.json().catch(() => null)) as {
    sid?: string;
    status?: string;
  } | null;
  if (!response.ok || !result?.sid) throw new Error('TWILIO_CALL_REJECTED');
  return { providerCallId: result.sid, status: result.status ?? 'queued' };
}

export function twilioSignaturePayload(url: string, form: URLSearchParams) {
  const pairs = Array.from(form.entries()).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return url + pairs.map(([key, value]) => `${key}${value}`).join('');
}

export async function validateTwilioSignature(input: {
  url: string;
  form: URLSearchParams;
  signature: string;
  authToken: string;
}) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(twilioSignaturePayload(input.url, input.form)),
    ),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  const expected = btoa(binary);
  if (expected.length !== input.signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1)
    mismatch |= expected.charCodeAt(index) ^ input.signature.charCodeAt(index);
  return mismatch === 0;
}
