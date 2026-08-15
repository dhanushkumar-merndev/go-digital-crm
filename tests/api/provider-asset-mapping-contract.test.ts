import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const adapter = source('supabase/functions/_shared/provider-oauth.ts');
const list = source('supabase/functions/integration-assets-list/index.ts');
const map = source('supabase/functions/integration-assets-map/index.ts');
const migration = source('supabase/migrations/202608150006_integration_asset_mapping.sql');
const config = source('supabase/config.toml');

describe('provider asset discovery and branch mapping contract', () => {
  it('refreshes Google access tokens server-side without replacing a retained refresh token', () => {
    expect(adapter).toContain("grant_type: 'refresh_token'");
    expect(adapter).toContain('token.refresh_token ?? credential.refresh_token');
    expect(list).toContain('refreshOAuthCredential(provider, currentCredential)');
  });

  it('discovers current provider asset families without returning Meta page tokens', () => {
    expect(adapter).toContain('/me/accounts');
    expect(adapter).toContain('customers:listAccessibleCustomers');
    expect(adapter).toContain('googleAds:search');
    expect(adapter).toContain("asset.type = 'LEAD_FORM'");
    expect(adapter).toContain('mybusinessbusinessinformation.googleapis.com');
    expect(list).toContain('assets: discovered.assets');
    expect(list).not.toContain('assetAccessTokens: discovered.assetAccessTokens');
  });

  it('revalidates assets, user branch access, connection scope, and team ownership', () => {
    expect(map).toContain("client.rpc('authorize_integration_connection_action'");
    expect(map).toContain('target_branch_id: branchId');
    expect(map).toContain('PROVIDER_ASSET_NOT_ACCESSIBLE');
    expect(migration).toContain("scope_mapping.external_resource_type = 'CONNECTION_SCOPE'");
    expect(migration).toContain('team_row.branch_id = mapping_row.branch_id');
    expect(migration).toContain("when 'ALL_BRANCHES' then");
    expect(migration).toContain('app_private.has_organization_wide_scope');
    expect(migration).toContain('create or replace function app_private.can_access_connection');
    expect(migration).toContain("'integration.view'");
  });

  it('stores only selected Meta page tokens inside the encrypted credential envelope', () => {
    expect(map).toContain('selectedAssetTokens');
    expect(map).toContain('await encryptJson(credentialToStore)');
    expect(migration).toContain('integration_mapping_metadata_has_no_secrets');
    expect(map).toContain('/subscribed_apps');
    expect(map).toContain("subscribed_fields: 'leadgen'");
  });

  it('makes mapping replacement service-only and keeps Edge endpoints JWT protected', () => {
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('revoke all on function public.replace_integration_asset_mappings');
    for (const functionName of ['integration-assets-list', 'integration-assets-map']) {
      expect(config).toContain(`[functions.${functionName}]\nverify_jwt = true`);
    }
  });
});
