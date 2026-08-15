import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150008_tenant_onboarding_review.sql');
const storageMigration = source('supabase/migrations/202608150004_object_storage_workflow.sql');
const onboarding = source('src/features/auth/business-owner-onboarding.tsx');

describe('Business Owner onboarding and platform review contract', () => {
  it('accepts only the primary organization-scoped Business Owner with MFA', () => {
    expect(migration).toContain('primary_owner_id = auth.uid()');
    expect(migration).toContain("assignment_row.data_scope = 'ORGANIZATION'");
    expect(migration).toContain("role_row.role_key = 'business_owner'");
    expect(migration).toContain('app_private.mfa_policy_satisfied');
  });

  it('requires all three private evidence types and verifies finalized object ownership', () => {
    for (const type of ['OWNER_IDENTITY', 'GST_CERTIFICATE', 'DEALERSHIP_AUTHORIZATION']) {
      expect(migration).toContain(`'${type}'`);
    }
    expect(migration).toContain("file_row.resource_type = 'organization'");
    expect(migration).toContain('file_row.uploaded_by = auth.uid()');
    expect(storageMigration).toContain("when 'organization' then");
    expect(onboarding).toContain("'object-upload-finalize'");
  });

  it('moves the tenant through review with audited decisions and required rejection reasons', () => {
    expect(migration).toContain("status = 'UNDER_REVIEW'");
    expect(migration).toContain("target_decision in ('REQUEST_CHANGES', 'REJECT')");
    expect(migration).toContain("when 'APPROVE' then 'ACTIVE'");
    expect(migration).toContain("'tenant.onboarding_approved'");
    expect(migration).toContain("'tenant.onboarding_changes_requested'");
  });

  it('uploads directly through short-lived Tigris URLs before submitting the RPC', () => {
    expect(onboarding).toContain("'presign-upload'");
    expect(onboarding).toContain("method: 'PUT'");
    expect(onboarding).toContain("createClient().rpc('submit_tenant_onboarding'");
  });
});
