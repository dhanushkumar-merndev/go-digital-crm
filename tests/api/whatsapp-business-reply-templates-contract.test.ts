import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/202610100773_whatsapp_business_reply_templates.sql');
const sendMessage = read('supabase/functions/send-message/index.ts');
const workspace = read('src/features/inbox/inbox-workspace.tsx');
const templates = read('src/features/inbox/whatsapp-business-templates.tsx');
const api = read('src/features/inbox/inbox-api.ts');

describe('Official WhatsApp reply templates', () => {
  it('lists only approved WhatsApp templates under conversation access and message.send', () => {
    expect(migration).toContain('from app_private.accessible_inbox_threads');
    expect(migration).toContain("channel = 'WHATSAPP_BUSINESS'");
    expect(migration).toContain(
      "app_private.has_permission(thread.organization_id, 'message.send')",
    );
    expect(migration).toContain("upper(template_row.status) = 'APPROVED'");
    expect(migration).toContain('template_row.provider_template_id is not null');
    expect(migration).toContain("'window_open', coalesce(window_expires_at > now(), false)");
    expect(migration).toContain(
      'revoke all on function public.get_whatsapp_business_reply_templates(uuid) from public, anon;',
    );
  });

  it('resolves the template on the server and refuses unapproved or incomplete ones', () => {
    expect(sendMessage).toContain("type: z.literal('crm_template')");
    expect(sendMessage).toContain(".from('templates')");
    expect(sendMessage).toContain('WHATSAPP_TEMPLATE_NOT_APPROVED');
    expect(sendMessage).toContain('WHATSAPP_TEMPLATE_VARIABLES_REQUIRED');
    // The free-text window rule is untouched; only templates pass outside it.
    expect(sendMessage).toContain("input.content.type === 'text' &&");
    expect(sendMessage).toContain('WHATSAPP_TEMPLATE_REQUIRED');
    // The thread shows what the customer received, not an empty bubble.
    expect(sendMessage).toContain(': (resolvedTemplate?.body ?? null),');
  });

  it('sends parameters in the same order as the drip dispatcher', () => {
    expect(sendMessage).toContain("left.localeCompare(right, 'en', { numeric: true })");
    expect(templates).toContain("left.localeCompare(right, 'en', { numeric: true })");
  });

  it('replaces the composer with a template prompt while the window is closed', () => {
    expect(workspace).toContain(
      'canSendBusiness && replyTemplates.isSuccess && !replyTemplates.data.window_open',
    );
    expect(workspace).toContain('The 24-hour reply window is closed.');
    expect(workspace).toContain('<WhatsAppBusinessTemplatePanel');
    expect(workspace).toContain('<WhatsAppTemplateSendDialog');
    expect(api).toContain("content: { type: 'crm_template', template_id: input.templateId");
  });

  it('keeps one idempotency key across a dropped connection only', () => {
    expect(templates).toContain(
      "if (code !== 'NETWORK_UNAVAILABLE') setApplicationMessageId(crypto.randomUUID());",
    );
  });

  it('does not call an empty thread a message without a body', () => {
    expect(workspace).not.toContain("'No message body available'");
    expect(workspace).toContain("'No messages yet'");
  });
});
