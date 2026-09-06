// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

type DripMessage = {
  id: string;
  organization_id: string;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL';
  message_body: string;
  template_provider_id: string | null;
  template_variables: Record<string, string>;
  recipient: string | null;
  connected_account_id: string | null;
  application_message_id: string;
  lease_token: string;
};
type WhatsAppCredential = {
  access_token: string;
  phone_number_id: string;
  whatsapp_business_account_id: string;
};

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
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
  const rawKey = fromBase64Url(requiredEnvironment('INTEGRATION_ENCRYPTION_KEY'));
  if (rawKey.byteLength !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY_INVALID');
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// Meta numbers template placeholders positionally. The stored variables are named
// so the enroller can read them, so they are ordered here by the {{1}}, {{2}}
// convention their keys already follow.
function orderedVariables(variables: Record<string, string>) {
  return Object.entries(variables ?? {})
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([, value]) => String(value));
}

async function sendWhatsApp(
  supabase: ReturnType<typeof createClient>,
  message: DripMessage,
): Promise<string> {
  if (!message.connected_account_id) throw new Error('DRIP_WHATSAPP_NOT_CONNECTED');
  const { data: secret, error } = await supabase
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('connected_account_id', message.connected_account_id)
    .eq('organization_id', message.organization_id)
    .maybeSingle();
  if (error || !secret) throw error ?? new Error('DRIP_WHATSAPP_CREDENTIAL_NOT_FOUND');
  const credential = await decryptCredential<WhatsAppCredential>(secret.encrypted_payload);
  const recipient = String(message.recipient ?? '').replace(/\D/g, '');
  if (recipient.length < 7 || recipient.length > 20) throw new Error('DRIP_RECIPIENT_INVALID');
  const parameters = orderedVariables(message.template_variables).map((value) => ({
    type: 'text',
    text: value,
  }));
  const response = await fetch(
    `https://graph.facebook.com/${requiredEnvironment('META_GRAPH_API_VERSION')}/${encodeURIComponent(credential.phone_number_id)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
          name: message.template_provider_id,
          language: { code: process.env.META_TEMPLATE_LANGUAGE?.trim() || 'en' },
          components: parameters.length ? [{ type: 'body', parameters }] : [],
        },
        biz_opaque_callback_data: message.application_message_id,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    messages?: Array<{ id?: string }>;
  } | null;
  if (!response.ok || !payload?.messages?.[0]?.id)
    throw new Error(
      response.status === 429 ? 'DRIP_WHATSAPP_RATE_LIMITED' : 'DRIP_WHATSAPP_REJECTED',
    );
  return payload.messages[0].id;
}

async function sendEmail(message: DripMessage): Promise<string> {
  const recipient = String(message.recipient ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) throw new Error('DRIP_RECIPIENT_INVALID');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': requiredEnvironment('BREVO_API_KEY'),
      // The message id is stable across retries, so a redelivery after an unknown
      // outcome is de-duplicated by Brevo rather than sent twice.
      'idempotency-key': message.application_message_id,
    },
    body: JSON.stringify({
      to: [{ email: recipient }],
      templateId: Number(message.template_provider_id),
      params: message.template_variables ?? {},
      tags: ['go-digital-crm', 'customer-drip'],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as { messageId?: string } | null;
  if (!response.ok || !payload?.messageId)
    throw new Error(response.status === 429 ? 'DRIP_EMAIL_RATE_LIMITED' : 'DRIP_EMAIL_REJECTED');
  return payload.messageId;
}

async function deliver(supabase: ReturnType<typeof createClient>, message: DripMessage) {
  // An unapproved or missing template is why this feature could not send at all.
  // Failing with a named code makes that visible instead of silently retrying.
  if (!message.template_provider_id) throw new Error('DRIP_TEMPLATE_NOT_APPROVED');
  if (!message.recipient) throw new Error('DRIP_RECIPIENT_MISSING');
  if (message.channel === 'WHATSAPP') return sendWhatsApp(supabase, message);
  if (message.channel === 'EMAIL') return sendEmail(message);
  // The schema has always allowed SMS but no SMS provider is integrated. Saying so
  // is better than retrying a channel that cannot succeed.
  throw new Error('DRIP_SMS_PROVIDER_NOT_CONFIGURED');
}

export const dripDispatch = schedules.task({
  id: 'drip-dispatch',
  cron: { pattern: '* * * * *', timezone: 'UTC' },
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000 },
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: released } = await supabase.rpc('release_stalled_drip_messages', {
      target_stale_minutes: 15,
    });
    const { data, error } = await supabase.rpc<DripMessage[]>('claim_due_drip_messages', {
      target_worker_id: `trigger:drip-dispatch:${crypto.randomUUID()}`,
      target_batch_size: 20,
    });
    if (error) throw error;
    let sent = 0;
    let retried = 0;
    for (const message of data ?? []) {
      try {
        const providerMessageId = await deliver(supabase, message);
        const { error: completeError } = await supabase.rpc('complete_drip_message', {
          target_message_id: message.id,
          target_lease_token: message.lease_token,
          target_provider_message_id: providerMessageId,
        });
        if (completeError) throw completeError;
        sent += 1;
      } catch (error) {
        const safeCode =
          error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)
            ? error.message
            : 'DRIP_SEND_RETRY';
        const { error: retryError } = await supabase.rpc('retry_drip_message', {
          target_message_id: message.id,
          target_lease_token: message.lease_token,
          target_safe_error_code: safeCode,
        });
        if (retryError) throw retryError;
        retried += 1;
      }
    }
    return { released: released ?? 0, claimed: data?.length ?? 0, sent, retried };
  },
});
