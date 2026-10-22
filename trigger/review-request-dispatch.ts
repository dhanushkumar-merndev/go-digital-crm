// The worker boundary is covered by its typed database RPC contract and runtime tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { createClient } from '@supabase/supabase-js';
import { deliver, type DripMessage } from './drip-dispatch';

type ReviewRequest = {
  id: string;
  organization_id: string;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL';
  template_provider_id: string | null;
  template_language: string | null;
  template_fields: string[] | null;
  template_parameter_format: string | null;
  template_variables: Record<string, string>;
  recipient: string | null;
  connected_account_id: string | null;
  application_message_id: string;
  lease_token: string;
};

// A retry cannot fix these: the template, connection, credential or recipient is
// wrong until a person changes it. Everything else (rate limits, provider
// outages, network errors) is retried by fail_review_request.
const permanentFailures = new Set([
  'REVIEW_TEMPLATE_NOT_APPROVED',
  'REVIEW_RECIPIENT_MISSING',
  'REVIEW_RECIPIENT_INVALID',
  'REVIEW_WHATSAPP_NOT_CONNECTED',
  'REVIEW_WHATSAPP_CREDENTIAL_NOT_FOUND',
  'REVIEW_WHATSAPP_REJECTED',
  'REVIEW_WHATSAPP_INVALID_PARAMETER',
  'REVIEW_WHATSAPP_TEMPLATE_MISMATCH',
  'REVIEW_SMS_NOT_CONNECTED',
  'REVIEW_SMS_CREDENTIAL_NOT_FOUND',
  'REVIEW_SMS_RECIPIENT_INVALID',
  'REVIEW_SMS_TEMPLATE_INVALID',
  'REVIEW_SMS_AUTH_FAILED',
  'REVIEW_SMS_IP_NOT_ALLOWED',
  'REVIEW_SMS_REJECTED',
  'REVIEW_EMAIL_NOT_CONNECTED',
  'REVIEW_EMAIL_CREDENTIAL_NOT_FOUND',
  'REVIEW_EMAIL_CREDENTIAL_INVALID',
  'REVIEW_EMAIL_REJECTED',
  'INTEGRATION_CREDENTIAL_INVALID',
  'INTEGRATION_CREDENTIAL_VERSION_UNSUPPORTED',
]);

// Meta template fields are stored as `header:1` / `body:name`, already in Meta's
// order. Same construction as send-message, so a template that sends from the
// inbox sends from here.
function whatsAppComponents(request: ReviewRequest) {
  const named = request.template_parameter_format === 'NAMED';
  const fields = request.template_fields ?? [];
  const parametersFor = (prefix: string) =>
    fields
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({
        type: 'text',
        ...(named ? { parameter_name: key.slice(prefix.length) } : {}),
        text: String(request.template_variables?.[key] ?? ''),
      }));
  const header = parametersFor('header:');
  const body = parametersFor('body:');
  return [
    ...(header.length ? [{ type: 'header', parameters: header }] : []),
    ...(body.length ? [{ type: 'body', parameters: body }] : []),
  ];
}

function asDripMessage(request: ReviewRequest): DripMessage {
  return {
    id: request.id,
    organization_id: request.organization_id,
    channel: request.channel,
    message_body: '',
    template_provider_id: request.template_provider_id,
    template_variables: request.template_variables ?? {},
    recipient: request.recipient,
    connected_account_id: request.connected_account_id,
    application_message_id: request.application_message_id,
    lease_token: request.lease_token,
    ...(request.channel === 'WHATSAPP'
      ? {
          template_language: request.template_language,
          template_components: whatsAppComponents(request),
        }
      : {}),
  };
}

/** One step of the marketing dispatch pass: due Google review requests. */
export async function runReviewRequestDispatch(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc<ReviewRequest[]>('claim_due_review_requests', {
    target_worker_id: `trigger:review-dispatch:${crypto.randomUUID()}`,
    target_batch_size: 20,
  });
  if (error) throw error;
  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (const request of data ?? []) {
    try {
      const providerMessageId = await deliver(supabase, asDripMessage(request));
      const { error: completeError } = await supabase.rpc('complete_review_request', {
        target_request_id: request.id,
        target_lease_token: request.lease_token,
        target_provider_message_id: providerMessageId,
      });
      if (completeError) throw completeError;
      sent += 1;
    } catch (caught) {
      const raw =
        caught instanceof Error && /^[A-Z0-9_]{3,100}$/.test(caught.message)
          ? caught.message
          : 'REVIEW_SEND_RETRY';
      const code = raw.replace(/^DRIP_/, 'REVIEW_');
      const { data: status, error: failError } = await supabase.rpc('fail_review_request', {
        target_request_id: request.id,
        target_lease_token: request.lease_token,
        target_safe_error_code: code,
        target_permanent: permanentFailures.has(code),
      });
      if (failError) throw failError;
      if (status === 'FAILED') failed += 1;
      else retried += 1;
    }
  }
  return { claimed: data?.length ?? 0, sent, retried, failed };
}
