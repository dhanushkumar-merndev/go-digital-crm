import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const portals = ['justdial', 'cardekho', 'carwale', 'indiamart'] as const;
const read = (path: string) => readFileSync(path, 'utf8');

describe('Marketplace portal webhook authentication', () => {
  const helper = read('supabase/functions/_shared/portal-webhook.ts');

  it('compares the supplied key in constant time and refuses connections without one', () => {
    expect(helper).toContain('constantTimeEqual(suppliedKey, storedKey)');
    expect(helper).toContain("'WEBHOOK_KEY_NOT_CONFIGURED'");
    expect(helper).toContain("'INVALID_WEBHOOK_KEY'");
    expect(helper).toContain("searchParams.get('key')");
    expect(helper).toContain("headers.get('x-webhook-key')");
  });

  for (const portal of portals) {
    it(`${portal} webhook verifies the key before ingesting any lead`, () => {
      const webhook = read(`supabase/functions/provider-webhook-${portal}/index.ts`);
      const verify = webhook.indexOf('rejectUnverifiedPortalWebhook(');
      expect(verify).toBeGreaterThan(-1);
      expect(verify).toBeLessThan(webhook.indexOf("rpc('ingest_provider_lead'"));
    });

    it(`${portal} connect stores a stable key and hands back the keyed URL`, () => {
      const connect = read(`supabase/functions/integration-connect-${portal}/index.ts`);
      expect(connect).toContain('loadPortalWebhookKey(');
      expect(connect).toContain('newPortalWebhookKey()');
      expect(connect).toContain('webhook_key: webhookKey');
      expect(connect).toContain('withPortalWebhookKey(');
    });

    it(`${portal} connect saves the telecaller team on the connection row`, () => {
      const connect = read(`supabase/functions/integration-connect-${portal}/index.ts`);
      const columnWrites = connect.match(/^\s{10}default_team_id: input\.default_team_id/gm);
      expect(columnWrites?.length).toBeGreaterThanOrEqual(2);
    });
  }
});
