import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readMetaLeadReceipt } from '../../src/lib/providers/provider-event-receipts';

const sync = readFileSync('supabase/functions/provider-sync-leads/index.ts', 'utf8');
const webhook = readFileSync('supabase/functions/provider-webhook-meta/index.ts', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

describe('Meta lead sync', () => {
  it('requires a signed-in user with integration.manage on the connection', () => {
    expect(config).toMatch(/\[functions\.provider-sync-leads\]\s*\nverify_jwt = true/);
    expect(sync).toContain("client.rpc('authorize_integration_connection_action'");
    expect(sync).toContain("target_permission: 'integration.manage'");
    expect(sync.indexOf("'PERMISSION_DENIED'")).toBeLessThan(sync.indexOf('await decryptJson<'));
  });

  it('queues the same receipt the webhook writes, idempotently', () => {
    expect(sync).toContain("event_type: 'META_LEADGEN'");
    expect(sync).toContain('eventId: `leadgen:${lead.id}`');
    expect(sync).toContain("onConflict: 'organization_id,connected_account_id,provider_event_id'");
    expect(sync).toContain('ignoreDuplicates: true');
    expect(webhook).toContain(
      "onConflict: 'organization_id,connected_account_id,provider_event_id'",
    );
  });

  it('produces a payload the dispatcher accepts', () => {
    const event = {
      eventId: 'leadgen:123456',
      leadId: '123456',
      pageId: '1386522521203430',
      formId: '987654',
      occurredAt: '2026-10-09T11:30:00.000Z',
    };
    expect(readMetaLeadReceipt({ event, origin: 'SYNC' }, 'leadgen:123456')).toEqual(event);
  });

  it('only syncs mapped Pages and only follows Graph pagination', () => {
    expect(sync).toContain("external_resource_type', 'META_PAGE'");
    expect(sync).toContain("url.hostname === 'graph.facebook.com'");
    expect(sync).toContain('MAX_LEADS_PER_SYNC');
  });

  it('keeps tokens out of responses and audits the sync', () => {
    expect(sync).not.toMatch(/success\([^)]*token/);
    expect(sync).toContain("action: 'integration.leads_synced'");
  });
});

describe('Meta webhook rejection logging', () => {
  it('records rejections only for a resolved tenant route', () => {
    expect(webhook).toContain('async function logRejection(');
    expect(webhook).toContain('if (!route) return;');
    for (const code of [
      'WEBHOOK_VERIFICATION_FAILED',
      'INVALID_SIGNATURE',
      'WEBHOOK_ROUTE_MISMATCH',
      'WEBHOOK_CONNECTION_MISMATCH',
      'META_WEBHOOK_FAILED',
    ])
      expect(webhook).toContain(`logRejection(admin, direct, '${code}'`);
  });
});
