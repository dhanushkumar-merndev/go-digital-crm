import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150005_support_session_workflow.sql');
const requestHandler = source('supabase/functions/support-session-request/index.ts');
const acceptHandler = source('supabase/functions/support-session-accept/index.ts');
const endHandler = source('supabase/functions/support-session-end/index.ts');
const config = source('supabase/config.toml');
const expiryWorker = source('trigger/support-session-expiry.ts');

describe('approved support-session contract', () => {
  it('requires platform MFA to request bounded existing permission keys', () => {
    expect(migration).toContain('not app_private.is_platform_admin()');
    expect(migration).toContain('not app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain('support_requests_one_pending_per_requester_idx');
    expect(migration).toContain("normalized_capabilities && array['support.approve']");
    expect(migration).toContain('left join public.permissions permission_row');
    expect(requestHandler).toContain("client.rpc('request_support_session'");
  });

  it('requires a distinct MFA-satisfied Business Owner decision', () => {
    expect(migration).toContain('request_row.requested_by = auth.uid()');
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain("permission_row.permission_key = 'support.approve'");
    expect(migration).toContain(
      'not app_private.has_organization_wide_scope(request_row.organization_id)',
    );
    expect(acceptHandler).toContain("decision: z.enum(['APPROVE', 'REJECT'])");
  });

  it('atomically enters and exits support maintenance with audit history', () => {
    expect(migration).toContain('support_sessions_one_open_per_tenant_idx');
    expect(migration).toContain('Automatically expired before a new approval');
    expect(migration).toContain("set status = 'SUPPORT_MAINTENANCE'");
    expect(migration).toContain("'support.approved'");
    expect(migration).toContain("set status = 'ACTIVE'");
    expect(migration).toContain("'support.ended'");
    expect(migration).toContain('termination_reason = normalized_termination_reason');
    expect(endHandler).toContain("client.rpc('end_support_session'");
  });

  it('expires abandoned sessions and restores the tenant through a scheduled worker', () => {
    expect(migration).toContain('create or replace function public.expire_support_sessions()');
    expect(migration).toContain("'support.expired'");
    expect(expiryWorker).toContain("id: 'support-session-expiry'");
    expect(expiryWorker).toContain("supabase.rpc('expire_support_sessions'");
  });

  it('keeps every support mutation behind JWT verification', () => {
    for (const functionName of [
      'support-session-request',
      'support-session-accept',
      'support-session-end',
    ]) {
      expect(config).toContain(`[functions.${functionName}]\nverify_jwt = true`);
    }
  });
});
