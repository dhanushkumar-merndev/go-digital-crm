import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source(
  'supabase/migrations/202608220043_tenant_company_compliance_workspace.sql',
);
const api = source('src/features/administration/company-compliance-workspace-api.ts');
const workspace = source('src/features/administration/company-compliance-workspace.tsx');

describe('tenant company and compliance workspace contract', () => {
  it('uses an organization-wide Client Admin or Business Owner read boundary', () => {
    expect(migration).toContain('get_tenant_company_compliance_workspace()');
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'user.manage')",
    );
    expect(migration).toContain('app_private.has_organization_wide_scope(current_organization_id)');
    expect(migration).toContain('app_private.mfa_policy_satisfied(current_organization_id)');
    expect(migration).toContain("role_row.role_key = 'client_admin'");
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain('COMPANY_COMPLIANCE_VIEW_PERMISSION_REQUIRED');
    expect(migration).toContain(
      'grant execute on function public.get_tenant_company_compliance_workspace() to authenticated',
    );
  });

  it('returns evidence metadata without leaking object references or granting mutations', () => {
    expect(migration).toContain("'document_type', document_source.document_type");
    expect(migration).toContain("'mime_type', file_source.mime_type");
    expect(migration).toContain("'size_bytes', file_source.size_bytes");
    expect(migration).not.toContain("'object_file_id'");
    expect(migration).not.toContain("'object_key'");
    expect(migration).not.toContain("'bucket'");
    expect(migration).not.toContain("'download_url'");
    expect(migration).not.toMatch(/\b(?:insert|update|delete)\s+public\./i);
  });

  it('validates the RPC payload and presents a read-only compliance record', () => {
    expect(api).toContain("rpc('get_tenant_company_compliance_workspace')");
    expect(api).toContain(
      "z.enum(['OWNER_IDENTITY', 'GST_CERTIFICATE', 'DEALERSHIP_AUTHORIZATION'])",
    );
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain('does not create download');
    expect(workspace).toContain('readOnly: true');
    expect(workspace).toContain('Business Owner or');
  });
});
