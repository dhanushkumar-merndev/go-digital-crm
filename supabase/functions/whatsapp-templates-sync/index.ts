import { z } from 'npm:zod@4';
import { decryptJson } from '../_shared/crypto.ts';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

// Pulls every message template from the WhatsApp Business Account behind one
// Official WhatsApp connection into the CRM catalog, where a Client Admin
// chooses which approved ones agents may send. Meta stays the source of truth
// for approval; nothing synced here is enabled automatically.
//
// GET /{WABA_ID}/message_templates needs the `whatsapp_business_management`
// permission on the stored token and pages with `paging.next`.

type WhatsAppCredential = {
  access_token: string;
  phone_number_id: string;
  whatsapp_business_account_id: string;
};

type MetaButton = { type?: string; text?: string; url?: string; phone_number?: string };
type MetaComponent = {
  type?: string;
  format?: string;
  text?: string;
  buttons?: MetaButton[];
};
type MetaTemplate = {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  parameter_format?: string;
  components?: MetaComponent[];
};

const schema = z.object({ organization_id: z.uuid(), connection_id: z.uuid() });
const MAX_PAGES = 20;
const placeholderPattern = /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g;
const hasPlaceholder = /\{\{\s*[A-Za-z0-9_]{1,40}\s*\}\}/;

function placeholders(text: string | undefined) {
  const found: string[] = [];
  for (const match of (text ?? '').matchAll(placeholderPattern)) {
    if (!found.includes(match[1]!)) found.push(match[1]!);
  }
  // Positional parameters go to Meta in number order; named ones in text order.
  return found.every((name) => /^\d+$/.test(name))
    ? found.sort((left, right) => Number(left) - Number(right))
    : found;
}

// The inbox can fill body and text-header variables. Everything else needs a
// value it has no way to collect yet, so those templates are listed but locked.
function normalize(template: MetaTemplate) {
  const components = template.components ?? [];
  const header = components.find((part) => part.type?.toUpperCase() === 'HEADER');
  const body = components.find((part) => part.type?.toUpperCase() === 'BODY');
  const footer = components.find((part) => part.type?.toUpperCase() === 'FOOTER');
  const buttons = components.find((part) => part.type?.toUpperCase() === 'BUTTONS')?.buttons ?? [];
  const category = template.category?.toUpperCase() ?? '';
  const headerFormat = header?.format?.toUpperCase();

  let unsupported: string | null = null;
  if (category === 'AUTHENTICATION') unsupported = 'Authentication (OTP) templates';
  else if (
    components.some((part) =>
      ['CAROUSEL', 'LIMITED_TIME_OFFER'].includes(part.type?.toUpperCase() ?? ''),
    )
  )
    unsupported = 'Carousel and offer templates';
  else if (header && headerFormat && headerFormat !== 'TEXT')
    unsupported = `${headerFormat.toLowerCase()} header`;
  else if (
    buttons.some(
      (button) =>
        ['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM'].includes(button.type?.toUpperCase() ?? '') ||
        (button.type?.toUpperCase() === 'URL' && hasPlaceholder.test(button.url ?? '')),
    )
  )
    unsupported = 'Buttons that need a value';

  const headerText =
    headerFormat === 'TEXT' || (!headerFormat && header?.text) ? header?.text : undefined;
  return {
    meta_template_id: String(template.id ?? ''),
    name: String(template.name ?? ''),
    language: String(template.language ?? ''),
    category: template.category ?? null,
    status: template.status ?? 'UNKNOWN',
    parameter_format: template.parameter_format?.toUpperCase() === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    header_text: headerText ?? null,
    body: body?.text ?? '',
    footer_text: footer?.text ?? null,
    buttons: buttons.map((button) => ({
      type: button.type ?? null,
      text: button.text ?? null,
    })),
    fields: [
      ...placeholders(headerText).map((name) => `header:${name}`),
      ...placeholders(body?.text).map((name) => `body:${name}`),
    ],
    supported: unsupported === null,
    unsupported_reason: unsupported,
  };
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The template sync request is invalid.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_integration_connection_action', {
      target_organization_id: input.organization_id,
      target_connection_id: input.connection_id,
      target_permission: 'integration.manage',
    });
    if (!permitted)
      return failure('PERMISSION_DENIED', 'You cannot manage this connection.', requestId, 403);

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,provider_key,status')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', 'whatsapp_cloud')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection)
      return failure(
        'CONNECTION_NOT_FOUND',
        'The Official WhatsApp connection was not found.',
        requestId,
        404,
      );
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', input.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (!secret)
      return failure('CREDENTIAL_NOT_CONFIGURED', 'Replace the credential first.', requestId, 409);
    const credential = await decryptJson<WhatsAppCredential>(secret.encrypted_payload);
    if (!credential.whatsapp_business_account_id)
      return failure(
        'WABA_NOT_CONFIGURED',
        'This connection has no WhatsApp Business Account ID. Replace the credential.',
        requestId,
        409,
      );
    const graphVersion = Deno.env.get('META_GRAPH_API_VERSION')?.trim();
    if (!graphVersion) throw new Error('META_GRAPH_API_VERSION_MISSING');

    const templates: MetaTemplate[] = [];
    let next: string | undefined =
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(credential.whatsapp_business_account_id)}/message_templates?` +
      new URLSearchParams({
        fields: 'id,name,language,status,category,parameter_format,components',
        limit: '100',
      }).toString();
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      pages += 1;
      const response = await fetch(next, {
        headers: { authorization: `Bearer ${credential.access_token}` },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: MetaTemplate[];
        paging?: { next?: string };
        error?: { code?: number };
      } | null;
      if (!response.ok || !payload) {
        const code =
          response.status === 429
            ? 'META_RATE_LIMITED'
            : payload?.error?.code === 190 || response.status === 401
              ? 'META_TOKEN_INVALID'
              : response.status === 403 ||
                  payload?.error?.code === 200 ||
                  payload?.error?.code === 10
                ? 'META_PERMISSION_MISSING'
                : 'META_TEMPLATES_UNAVAILABLE';
        await admin.from('audit_logs').insert({
          organization_id: input.organization_id,
          actor_id: auth.user.id,
          action: 'whatsapp_template.sync_failed',
          resource_type: 'connected_account',
          resource_id: connection.id,
          request_id: requestId,
          metadata: { code, http_status: response.status },
        });
        return failure(
          code,
          code === 'META_PERMISSION_MISSING'
            ? 'The WhatsApp token needs the whatsapp_business_management permission.'
            : code === 'META_TOKEN_INVALID'
              ? 'The WhatsApp access token is invalid or expired. Replace the credential.'
              : 'Meta did not return the templates. Try again shortly.',
          requestId,
          502,
        );
      }
      templates.push(...(payload.data ?? []));
      next = payload.paging?.next;
    }

    const normalized = templates
      .map(normalize)
      .filter((item) => item.meta_template_id && item.name && item.language);
    const { data: result, error } = await admin.rpc('sync_whatsapp_business_templates', {
      target_organization_id: input.organization_id,
      target_connection_id: connection.id,
      target_templates: normalized,
    });
    if (error) throw error;
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'whatsapp_template.synced',
      resource_type: 'connected_account',
      resource_id: connection.id,
      request_id: requestId,
      metadata: { ...(result ?? {}), truncated: Boolean(next) },
    });
    return success(
      {
        synced: normalized.length,
        approved: normalized.filter((item) => item.status.toUpperCase() === 'APPROVED').length,
        removed: Number((result as { removed?: number } | null)?.removed ?? 0),
        truncated: Boolean(next),
      },
      requestId,
    );
  } catch {
    return failure(
      'TEMPLATE_SYNC_FAILED',
      'Templates could not be synced. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
