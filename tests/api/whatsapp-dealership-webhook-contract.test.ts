import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const webhook = read('supabase/functions/provider-webhook-whatsapp/index.ts');
const connect = read('supabase/functions/integration-connect-whatsapp/index.ts');
const setup = read('src/features/integrations/whatsapp-webhook-setup.tsx');
const integrations = read('src/features/integrations/integration-workspace.tsx');

describe('Official WhatsApp webhook on a dealership Meta app', () => {
  it('verifies a connection callback with that connection’s token and app secret', () => {
    expect(webhook).toContain("url.searchParams.get('connection')");
    expect(webhook).toContain(".contains('connection_config', { webhook_mode: 'DEALERSHIP_APP' })");
    expect(webhook).toContain(
      "dealership.route?.verifyToken ?? Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN')",
    );
    expect(webhook).toContain("dealership.route?.appSecret ?? Deno.env.get('META_APP_SECRET')");
    expect(webhook).toContain("failure('WEBHOOK_ROUTE_INVALID'");
  });

  it('accepts only the connection’s own phone numbers from its callback', () => {
    expect(webhook).toContain('route.connectionId === dealership.route.connectionId');
    expect(webhook).toContain('const route = routeFor(message.phoneNumberId);');
    expect(webhook).toContain('const route = routeFor(status.phoneNumberId);');
  });

  it('stores the app secret and verify token encrypted, together or not at all', () => {
    expect(connect).toContain("'WHATSAPP_WEBHOOK_SETTINGS_INCOMPLETE'");
    expect(connect).toContain('input.app_secret ?? storedWebhook.app_secret');
    expect(connect).toContain('input.webhook_verify_token ?? storedWebhook.webhook_verify_token');
    expect(connect).toContain(
      '? { app_secret: appSecret, webhook_verify_token: webhookVerifyToken }',
    );
    expect(connect).toContain('/provider-webhook-whatsapp?connection=${connectionId}');
    expect(connect).toContain('webhook_url: webhookUrl,');
  });

  it('shows the callback URL to integration managers without revealing stored secrets', () => {
    expect(integrations).toContain(
      "connection.provider_key === 'whatsapp_cloud' && canManage && (",
    );
    expect(integrations).toContain('webhookUrl={connection.connection_config.webhook_url}');
    expect(setup).toContain('not shown');
    expect(setup).not.toContain('webhook_verify_token');
    expect(setup).not.toContain('app_secret');
  });
});
