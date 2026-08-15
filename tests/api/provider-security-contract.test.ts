import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150002_provider_integrations.sql');
const encryption = source('supabase/functions/_shared/crypto.ts');
const metaWebhook = source('supabase/functions/provider-webhook-meta/index.ts');
const googleWebhook = source('supabase/functions/provider-webhook-generic/index.ts');
const whatsAppWebhook = source('supabase/functions/provider-webhook-whatsapp/index.ts');
const supabaseConfig = source('supabase/config.toml');
const providerOutbox = source('trigger/provider-outbox.ts');
const providerEventDispatch = source('trigger/provider-event-dispatch.ts');
const providerEventMigration = source(
  'supabase/migrations/202608150009_provider_event_dispatch.sql',
);

describe('provider integration security and delivery contract', () => {
  it('keeps OAuth state and provider credentials server-only and encrypted', () => {
    expect(migration).toContain('revoke all on public.integration_oauth_states');
    expect(migration).toContain('revoke insert, update, delete, truncate');
    expect(encryption).toContain("version: 'AES-256-GCM-v1'");
    expect(encryption).toContain("{ name: 'AES-GCM', iv }");
    expect(encryption).toContain('raw.byteLength !== 32');
  });

  it('makes provider lead ingestion service-only, idempotent and auditable', () => {
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('ACTIVE_CONNECTION_NOT_FOUND');
    expect(migration).toContain("'lead.provider_ingested'");
    expect(migration).toContain('last_fresh_assigned_at asc nulls first');
  });

  it('verifies Meta signatures over the raw body before parsing provider JSON', () => {
    expect(metaWebhook.indexOf('hmacSha256Hex(appSecret, rawBody)')).toBeLessThan(
      metaWebhook.indexOf('JSON.parse(rawBody)'),
    );
    expect(whatsAppWebhook.indexOf('hmacSha256Hex(appSecret, rawBody)')).toBeLessThan(
      whatsAppWebhook.indexOf('JSON.parse(rawBody)'),
    );
  });

  it('uses constant-time Google key validation and preserves retryable failures', () => {
    expect(googleWebhook).toContain(
      'constantTimeEqual(envelope.googleKey, credential.google_webhook_key)',
    );
    expect(googleWebhook).toContain("'RECEIVED'");
    expect(whatsAppWebhook).toContain("status: 'RECEIVED'");
    expect(providerEventDispatch).toContain("supabase.rpc('retry_provider_event'");
    expect(providerEventMigration).toContain("'PENDING_RECONCILIATION'");
  });

  it('disables gateway JWT checks only on independently verified public boundaries', () => {
    for (const functionName of [
      'integration-oauth-callback',
      'provider-webhook-meta',
      'provider-webhook-whatsapp',
      'provider-webhook-generic',
      'mobile-link-exchange',
    ]) {
      expect(supabaseConfig).toContain(`[functions.${functionName}]\nverify_jwt = false`);
    }
    for (const functionName of ['integration-oauth-start', 'send-email', 'send-message']) {
      expect(supabaseConfig).toContain(`[functions.${functionName}]\nverify_jwt = true`);
    }
  });

  it('has a durable worker for provider retries and unknown-result reconciliation', () => {
    expect(providerOutbox).toContain("id: 'provider-outbox-dispatch'");
    expect(providerOutbox).toContain("supabase.rpc('claim_domain_outbox'");
    expect(providerOutbox).toContain("supabase.rpc('complete_domain_outbox'");
    expect(providerOutbox).toContain("supabase.rpc('retry_domain_outbox'");
    expect(providerOutbox).toContain("'idempotency-key': message.application_message_id");
    expect(providerOutbox).toContain("'message.status.reconcile'");
  });
});
