import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150010_controlled_retention_workflow.sql');
const worker = source('trigger/retention-purge.ts');

describe('controlled tenant-retention contract', () => {
  it('soft-deletes only allowlisted tenant roots through an MFA platform workflow', () => {
    expect(migration).toContain("resource_type = 'ORGANIZATION' and resource_id = organization_id");
    expect(migration).toContain('perform app_private.require_platform_retention_actor()');
    expect(migration).toContain("set status = 'SOFT_DELETED'");
    expect(migration).toContain("last_error_code = 'TENANT_SOFT_DELETED'");
    expect(migration).toContain("set status = 'TENANT_SUSPENDED'");
    expect(migration).toContain("set_config('app.controlled_retention_transition', 'on', true)");
    expect(migration).toContain(
      "current_setting('app.controlled_retention_transition', true) = 'on'",
    );
    expect(migration).toContain('deletion_requests_one_open_tenant_idx');
    expect(migration).toContain('request_idempotency_key uuid');
    expect(migration).toContain('app_private.sha256_hex');
    expect(migration).not.toContain('encode(digest(');
  });

  it('requires a distinct approval and supports audited restore, extension, and legal hold', () => {
    expect(migration).toContain('DISTINCT_RETENTION_APPROVER_REQUIRED');
    expect(migration).toContain('restore_soft_deleted_tenant');
    expect(migration).toContain('RESTORE_WINDOW_CLOSED');
    expect(migration).toContain('set_tenant_deletion_legal_hold');
    expect(migration).toContain('extend_tenant_retention');
    expect(migration).toContain("'retention.tenant_restored'");
    expect(migration).toContain("'retention.legal_hold_applied'");
    expect(migration).toContain("'APPROVED', 'PURGING', 'FAILED'");
  });

  it('claims eligible work with a retry-safe lease and a durable final manifest', () => {
    expect(migration).toContain('for update of job_row, request_candidate skip locked');
    expect(migration).toContain("leased_until = now() + interval '10 minutes'");
    expect(migration).toContain('purge_manifest_objects');
    expect(migration).toContain('purge_manifest_auth_identities');
    expect(migration).toContain('retry_controlled_purge');
    expect(migration).toContain('requeue_failed_tenant_purge');
    expect(migration).toContain('final_checksum');
    expect(migration).toContain("'external_provider_token_revocation'");
    expect(migration).toContain("'NOT_EXECUTED_REQUIRES_PROVIDER_ADAPTER'");
    expect(migration).toContain(
      'on conflict on constraint purge_manifests_deletion_request_id_key',
    );
  });

  it('fails closed when the tenant schema outgrows the reviewed purge allowlist', () => {
    expect(migration).toContain('app_private.retention_table_allowlist');
    expect(migration).toContain("column_row.column_name = 'organization_id'");
    expect(migration).toContain('PURGE_SCHEMA_ALLOWLIST_STALE');
    expect(migration.match(/PURGE_SCHEMA_ALLOWLIST_STALE/g)).toHaveLength(2);
    expect(migration).toContain('PURGE_RESIDUAL_DATA_FOUND');
    expect(migration).toContain("object_row.source_type = 'UPLOAD_INTENT'");
    expect(migration).toContain('target_batch_size not between 100 and 10000');
  });

  it('removes dependent records and irreversibly anonymizes retained identity roots', () => {
    expect(migration).toContain("('profiles', 'ANONYMIZE', null)");
    expect(migration).toContain("email = id::text || '@deleted.invalid'");
    expect(migration).toContain("slug = 'purged-' || id::text");
    expect(migration).toContain("reason = '[redacted after controlled purge]'");
    expect(migration).toContain('redacted_by_controlled_purge');
    expect(migration).toContain('DELETE_DEPENDENTS_AND_IRREVERSIBLY_ANONYMIZE_ROOT');
  });

  it('keeps raw storage locators and auth IDs server-only', () => {
    expect(migration).toContain(
      'revoke all on public.purge_manifest_objects from public, anon, authenticated',
    );
    expect(migration).toContain(
      'revoke all on public.purge_manifest_auth_identities from public, anon, authenticated',
    );
    expect(migration).not.toContain(
      'grant select on public.purge_manifest_objects to authenticated',
    );
    expect(migration).toContain("auth.role() <> 'service_role'");
  });

  it('deletes Tigris objects and irreversibly soft-deletes Auth users before data finalization', () => {
    expect(worker).toContain('new DeleteObjectCommand');
    expect(worker).toContain('object.bucket !== configuredBucket');
    expect(worker).toContain("renewLease(supabase, claim, 'STORAGE')");
    expect(worker).toContain("renewLease(supabase, claim, 'AUTH')");
    expect(worker).toContain('target_batch_size: 1');
    expect(worker).toContain('supabase.auth.admin.deleteUser(identity.user_id, true)');
    expect(worker).toContain("supabase.rpc('purge_tenant_data_batch'");
    expect(worker).toContain("supabase.rpc('finalize_controlled_tenant_purge'");
    expect(worker).toContain("supabase.rpc('retry_controlled_purge'");
  });

  it('disables the unsafe legacy completion shortcut', () => {
    expect(migration).toContain('LEGACY_PURGE_ENTRYPOINT_DISABLED');
    expect(migration).toContain('from public, anon, authenticated, service_role;');
    expect(worker).not.toContain("rpc('complete_controlled_purge'");
  });
});
