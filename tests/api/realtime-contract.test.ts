import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformRealtimeTopic, tenantRealtimeTopic } from '../../src/lib/realtime/topics';

const migration = readFileSync(
  new URL('../../supabase/migrations/202608150013_realtime_invalidation.sql', import.meta.url),
  'utf8',
);
const hook = readFileSync(
  new URL('../../src/lib/realtime/use-realtime-invalidation.ts', import.meta.url),
  'utf8',
);

describe('Realtime invalidation contract', () => {
  it('broadcasts sanitized invalidation metadata through private topics', () => {
    expect(migration).toContain("'resource', tg_argv[0]");
    expect(migration).toContain("'operation', tg_op");
    expect(migration).toContain("'record_id', target_record_id");
    expect(migration).toContain('select realtime.send($1, $2, $3, true)');
    expect(migration).not.toMatch(/realtime\.send\([^;]*(?:to_jsonb\((?:new|old)\)|row_data)/i);
  });

  it('requires RLS-protected private subscriptions for tenant and platform topics', () => {
    expect(migration).toContain('create policy crm_tenant_broadcast_read');
    expect(migration).toContain('app_private.can_access_organization');
    expect(migration).toContain('app_private.has_permission');
    expect(migration).toContain('create policy crm_platform_broadcast_read');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(hook).toContain('config: { private: true }');
    expect(hook).toContain('supabase.realtime.setAuth()');
    expect(hook).toContain('supabase.removeChannel(channel)');
  });

  it('uses strict, non-secret topic names', () => {
    const organizationId = '123e4567-e89b-42d3-a456-426614174000';
    expect(tenantRealtimeTopic(organizationId, 'leads')).toBe(
      `organization:${organizationId}:leads`,
    );
    expect(platformRealtimeTopic('onboarding')).toBe('platform:onboarding');
    expect(() => tenantRealtimeTopic('not-an-organization', 'leads')).toThrow(
      'INVALID_REALTIME_ORGANIZATION',
    );
  });

  it('does not broadcast ordinary hard deletes', () => {
    expect(migration).not.toMatch(/after\s+(?:insert\s+or\s+update\s+or\s+delete|delete)/i);
  });
});
