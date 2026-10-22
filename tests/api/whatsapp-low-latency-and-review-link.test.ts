import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const webhook = source('supabase/functions/provider-webhook-whatsapp/index.ts');
const sendMessage = source('supabase/functions/send-message/index.ts');
const migration = source('supabase/migrations/202610221637_whatsapp_review_template.sql');
const reviewButton = source('src/features/inbox/inbox-review-link.tsx');
const workspace = source('src/features/inbox/inbox-workspace.tsx');

describe('WhatsApp webhook applies receipts inline', () => {
  it('claims with the shared lease so the worker never processes an event twice', () => {
    expect(webhook).toContain("admin.rpc('claim_provider_event_receipts'");
    expect(webhook).toContain("admin.rpc('ingest_whatsapp_inbound_message'");
    expect(webhook).toContain("admin.rpc('apply_whatsapp_message_status'");
    expect(webhook).toContain("admin.rpc('complete_provider_event'");
    expect(webhook).toContain("admin.rpc('retry_provider_event'");
  });

  it('answers Meta first and falls back to the Trigger.dev worker only on failure', () => {
    const tail = webhook.slice(webhook.indexOf('EdgeRuntime.waitUntil('));
    expect(tail.indexOf('applyReceiptsInline(')).toBeLessThan(
      tail.indexOf("'provider-event-dispatch-now'"),
    );
    expect(tail).toContain('return;');
  });

  it('retries a status that beats the send response once, without waiting a minute', () => {
    expect(webhook).toContain('setTimeout(resolve, 1500)');
    expect(webhook).toContain("'WHATSAPP_OUTBOUND_MESSAGE_NOT_FOUND'");
  });
});

describe('send-message overlaps independent reads', () => {
  it('reads the user, personal probe and conversation together', () => {
    expect(sendMessage).toMatch(
      /await Promise\.all\(\[\s*client\.auth\.getUser\(\),\s*personalPrepare,\s*conversationLookup,\s*\]\)/,
    );
  });

  it('checks permission before using anything read alongside it', () => {
    const start = sendMessage.indexOf("client.rpc('authorize_action'");
    const permissionGate = sendMessage.indexOf('if (!permitted)', start);
    expect(start).toBeGreaterThan(0);
    expect(sendMessage.indexOf('connectionResult.data')).toBeGreaterThan(permissionGate);
    expect(sendMessage.indexOf('= existingResult;')).toBeGreaterThan(permissionGate);
  });
});

describe('review link template', () => {
  it('is set only by integration managers and never read directly', () => {
    expect(migration).toContain(
      'alter table public.whatsapp_review_templates force row level security',
    );
    expect(migration).toContain(
      'revoke all on public.whatsapp_review_templates from anon, authenticated',
    );
    expect(migration).toMatch(
      /set_whatsapp_review_template[\s\S]*?authorize_integration_connection_action\(org, target_connection_id, 'integration\.manage'\)/,
    );
    expect(migration).toContain("'whatsapp_review_template.set'");
  });

  it('accepts only an enabled, approved template of the same connection with every field filled', () => {
    expect(migration).toContain('candidate.connected_account_id = target_connection_id');
    expect(migration).toContain("candidate.meta_status = 'APPROVED'");
    expect(migration).toContain("message = 'REVIEW_TEMPLATE_FIELD_REQUIRED'");
  });

  it('resolves for the agent only on an accessible thread and a genuine review link', () => {
    expect(migration).toContain('from app_private.accessible_inbox_threads');
    expect(migration).toContain("target_review_link !~ '^https://[^\\s]+/feedback/[0-9a-f]{64}$'");
    expect(migration).toContain("return jsonb_build_object('configured', false)");
  });

  it('sends text inside the window and the template outside it, through existing paths', () => {
    expect(reviewButton).toContain("createReviewRequest({ leadId, channel: 'WHATSAPP' })");
    expect(reviewButton).toContain('const asText = personal || windowOpen === true;');
    expect(reviewButton).toContain('sendInboxWhatsAppTemplate({');
    expect(workspace).toContain('function enqueueReply(body: string)');
  });
});
