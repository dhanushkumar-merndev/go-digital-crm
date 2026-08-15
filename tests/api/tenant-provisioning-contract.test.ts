import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150007_tenant_provisioning.sql');
const handler = source('supabase/functions/tenant-provision/index.ts');
const inviteAcceptor = source('src/features/auth/invite-session-acceptor.tsx');
const config = source('supabase/config.toml');

describe('tenant and initial Business Owner provisioning contract', () => {
  it('requires an MFA-satisfied Super Admin before using the trusted admin boundary', () => {
    expect(handler).toContain("context.role_key !== 'super-admin'");
    expect(handler).toContain('context.mfa_satisfied !== true');
    expect(migration).toContain("actor_role.role_key = 'super_admin'");
    expect(migration).toContain("actor_assignment.data_scope = 'PLATFORM'");
  });

  it('creates the tenant, MFA-required owner profile, presets and organization scope atomically', () => {
    expect(migration).toContain("'ONBOARDING'");
    expect(migration).toContain('perform public.provision_default_roles(created_organization_id)');
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain("'ORGANIZATION'");
    expect(migration).toContain("'tenant.owner_provisioned'");
  });

  it('uses the official one-time Auth invite and compensates only a newly-created orphan', () => {
    expect(handler).toContain('admin.auth.admin.inviteUserByEmail');
    expect(handler).toContain("new URL('/auth/invite', baseUrl.origin)");
    expect(handler).toContain('deleteUser(invitedUserId, false)');
    expect(inviteAcceptor).toContain("type: 'invite'");
    expect(inviteAcceptor).toContain('supabase.auth.setSession');
  });

  it('keeps the provisioning Edge function behind gateway JWT verification', () => {
    expect(config).toContain('[functions.tenant-provision]\nverify_jwt = true');
  });
});
