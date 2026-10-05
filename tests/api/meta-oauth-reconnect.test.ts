import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOAuthStartPayload } from '../../src/features/integrations/integration-oauth-connection';
import { oauthStartAuthorization } from '../../src/lib/providers/integration-oauth-authorization';
import {
  oauthCallbackFailureUpdate,
  prepareMetaOAuthReconnect,
} from '../../src/lib/providers/meta-oauth-reconnect';

const callback = readFileSync('supabase/functions/integration-oauth-callback/index.ts', 'utf8');
const completionMigration = readFileSync(
  'supabase/migrations/202610040001_complete_oauth_connection_atomically.sql',
  'utf8',
);

describe('Meta OAuth reconnect', () => {
  it('commits the replacement credential and connection state atomically', () => {
    expect(completionMigration).toContain(
      'create or replace function public.complete_integration_oauth_connection',
    );
    expect(completionMigration).toContain('insert into public.integration_credentials');
    expect(completionMigration).toContain('update public.connected_accounts');
    expect(completionMigration).toContain(
      'grant execute on function public.complete_integration_oauth_connection',
    );
    expect(callback).toContain(".rpc('complete_integration_oauth_connection'");
    expect(callback).not.toContain(".from('integration_credentials').upsert");
    expect(callback).toContain("['META_DIRECT', 'META_OAUTH'].includes");
  });

  it('authorizes reconnects against the existing connection scope', () => {
    expect(
      oauthStartAuthorization({
        connectionId: '22222222-2222-4222-8222-222222222222',
        organizationId: '11111111-1111-4111-8111-111111111111',
        scopeMode: 'ONE_BRANCH',
        branchIds: ['33333333-3333-4333-8333-333333333333'],
      }),
    ).toEqual({
      rpc: 'authorize_integration_connection_action',
      args: {
        target_organization_id: '11111111-1111-4111-8111-111111111111',
        target_connection_id: '22222222-2222-4222-8222-222222222222',
        target_permission: 'integration.manage',
      },
    });

    expect(
      oauthStartAuthorization({
        organizationId: '11111111-1111-4111-8111-111111111111',
        scopeMode: 'ONE_BRANCH',
        branchIds: ['33333333-3333-4333-8333-333333333333'],
      }),
    ).toEqual({
      rpc: 'authorize_integration_scope',
      args: {
        target_organization_id: '11111111-1111-4111-8111-111111111111',
        target_permission: 'integration.manage',
        target_scope_mode: 'ONE_BRANCH',
        target_branch_ids: ['33333333-3333-4333-8333-333333333333'],
      },
    });
  });

  it('targets the existing connection when Facebook login replaces a manual credential', () => {
    expect(
      buildOAuthStartPayload({
        organizationId: '11111111-1111-4111-8111-111111111111',
        connectionId: '22222222-2222-4222-8222-222222222222',
        providerKey: 'meta',
        displayName: 'Facebook Lead Ads',
        scopeMode: 'ONE_BRANCH',
        branchIds: ['33333333-3333-4333-8333-333333333333'],
        redirectPath: '/client-admin/integrations',
      }),
    ).toEqual({
      organization_id: '11111111-1111-4111-8111-111111111111',
      connection_id: '22222222-2222-4222-8222-222222222222',
      provider_key: 'meta',
      display_name: 'Facebook Lead Ads',
      scope_mode: 'ONE_BRANCH',
      branch_ids: ['33333333-3333-4333-8333-333333333333'],
      redirect_path: '/client-admin/integrations',
    });
  });

  it('keeps the mapped Page live while replacing its manual credential with OAuth', () => {
    const replacement = prepareMetaOAuthReconnect({
      credential: {
        access_token: 'long-lived-user-token',
        token_type: 'bearer',
        expires_at: '2026-12-03T00:00:00.000Z',
        external_account_id: 'meta-user-1',
        external_account_label: 'Dealer Admin',
      },
      connection: {
        status: 'CONNECTED',
        external_account_id: '1386522521203430',
        connection_config: {
          connection_type: 'META_DIRECT',
          page_id: '1386522521203430',
          webhook_route_hash: 'old-direct-route',
          capabilities: ['LEAD_INGEST'],
          subscription_status: 'SUBSCRIBED',
        },
      },
      graphApiVersion: 'v26.0',
      assets: [
        {
          id: '1386522521203430',
          type: 'META_PAGE',
          label: 'Ashok Gowdas',
        },
        {
          id: '9999999999999999',
          type: 'META_PAGE',
          label: 'Another Page',
        },
      ],
      assetAccessTokens: {
        '1386522521203430': 'selected-page-token',
        '9999999999999999': 'unselected-page-token',
      },
    });

    expect(replacement.credential).toMatchObject({
      external_account_id: '1386522521203430',
      external_account_label: 'Ashok Gowdas',
      graph_api_version: 'v26.0',
      asset_access_tokens: { '1386522521203430': 'selected-page-token' },
    });
    expect(replacement.connectionUpdate).toEqual({
      status: 'CONNECTED',
      auth_type: 'OAUTH2',
      external_account_id: '1386522521203430',
      token_expires_at: '2026-12-03T00:00:00.000Z',
      last_error_code: null,
      connection_config: {
        connection_type: 'META_OAUTH',
        page_id: '1386522521203430',
        graph_api_version: 'v26.0',
        capabilities: ['LEAD_INGEST'],
        subscription_status: 'SUBSCRIBED',
      },
    });
  });

  it('refuses to replace the credential when Facebook login cannot access the mapped Page', () => {
    expect(() =>
      prepareMetaOAuthReconnect({
        credential: {
          access_token: 'long-lived-user-token',
          token_type: 'bearer',
          external_account_id: 'meta-user-1',
          external_account_label: 'Dealer Admin',
        },
        connection: {
          status: 'CONNECTED',
          external_account_id: '1386522521203430',
          connection_config: { connection_type: 'META_DIRECT' },
        },
        graphApiVersion: 'v26.0',
        assets: [],
        assetAccessTokens: {},
      }),
    ).toThrowError('META_RECONNECT_PAGE_NOT_ACCESSIBLE');
  });

  it('does not take a working manual connection offline when OAuth is cancelled or fails', () => {
    expect(oauthCallbackFailureUpdate('CONNECTED')).toEqual({
      status: 'CONNECTED',
      last_error_code: 'OAUTH_CALLBACK_FAILED',
    });
    expect(oauthCallbackFailureUpdate('AUTHORIZING')).toEqual({
      status: 'ERROR',
      last_error_code: 'OAUTH_CALLBACK_FAILED',
    });
  });
});
