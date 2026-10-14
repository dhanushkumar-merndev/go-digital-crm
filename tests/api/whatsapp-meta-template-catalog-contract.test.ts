import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/202610100873_whatsapp_meta_template_catalog.sql');
const sync = read('supabase/functions/whatsapp-templates-sync/index.ts');
const sendMessage = read('supabase/functions/send-message/index.ts');
const card = read('src/features/integrations/whatsapp-templates-card.tsx');
const integrations = read('src/features/integrations/integration-workspace.tsx');
const dialog = read('src/features/inbox/whatsapp-business-templates.tsx');
const config = read('supabase/config.toml');

describe('WhatsApp template catalog synced from Meta', () => {
  it('syncs every template of the connection, server-side, for integration managers only', () => {
    expect(sync).toContain("target_permission: 'integration.manage'");
    expect(sync).toContain('/message_templates?');
    expect(sync).toContain(
      "fields: 'id,name,language,status,category,parameter_format,components'",
    );
    expect(sync).toContain('payload.paging?.next');
    expect(sync).toContain("admin.rpc('sync_whatsapp_business_templates'");
    expect(config).toContain('[functions.whatsapp-templates-sync]\nverify_jwt = true');
  });

  it('locks templates the inbox cannot fill in', () => {
    expect(sync).toContain("unsupported = 'Authentication (OTP) templates'");
    expect(sync).toContain('header`');
    expect(sync).toContain("unsupported = 'Buttons that need a value'");
    expect(migration).toContain('check (not enabled or supported)');
  });

  it('keeps the catalog behind functions and nothing enabled by default', () => {
    expect(migration).toContain('enabled boolean not null default false');
    expect(migration).toContain(
      'revoke all on public.whatsapp_business_templates from anon, authenticated;',
    );
    expect(migration).toMatch(
      /grant execute on function public\.sync_whatsapp_business_templates\(uuid, uuid, jsonb\)\s+to service_role;/,
    );
    // A template that disappears from Meta or becomes unsendable switches off.
    expect(migration).toContain('enabled = existing.enabled and excluded.supported');
    expect(migration).toContain(
      'removed_from_meta_at = coalesce(template_row.removed_from_meta_at, now())',
    );
  });

  it('audits every toggle and refuses one Meta does not approve', () => {
    expect(migration).toContain("'whatsapp_template.enabled' else 'whatsapp_template.disabled'");
    expect(migration).toContain('WHATSAPP_TEMPLATE_NOT_ENABLEABLE');
    expect(migration).toContain(
      "public.authorize_integration_connection_action(\n      org, template_row.connected_account_id, 'integration.manage')",
    );
  });

  it('offers only enabled templates of the conversation’s own connection', () => {
    expect(migration).toContain('and meta_row.connected_account_id = thread_connection_id');
    expect(migration).toContain('and meta_row.enabled');
    expect(sendMessage).toContain(".eq('connected_account_id', conversation.connection_id)");
    expect(sendMessage).toContain(".eq('enabled', true)");
  });

  it('sends header and body fields in Meta order, named or positional', () => {
    expect(sendMessage).toContain('...(named ? { parameter_name: key.slice(prefix.length) } : {})');
    expect(sendMessage).toContain("[{ type: 'header', parameters: header }]");
    expect(sendMessage).toContain('languageCode: metaTemplate.language');
    expect(dialog).toContain("return key.replace(/^(header|body):/, '');");
  });

  it('shows the catalog on the WhatsApp connection for managers', () => {
    expect(integrations).toContain("connection.provider_key === 'whatsapp_cloud' &&");
    expect(integrations).toContain('<WhatsAppTemplatesCard');
    expect(card).toContain("'set_whatsapp_business_template_enabled'");
    expect(card).toContain("invokeIntegrationFunction<SyncResult>('whatsapp-templates-sync'");
  });
});
