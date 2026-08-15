import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150004_object_storage_workflow.sql');
const upload = source('supabase/functions/presign-upload/index.ts');
const finalize = source('supabase/functions/object-upload-finalize/index.ts');
const download = source('supabase/functions/presign-download/index.ts');
const config = source('supabase/config.toml');

describe('private object-storage workflow contract', () => {
  it('keeps upload intents private and finalization service-only', () => {
    expect(migration).toContain('force row level security');
    expect(migration).toContain('revoke all on public.object_upload_intents');
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('object_upload_intent_branch_tenant_fk');
  });

  it('authorizes the concrete resource before creating either signed URL', () => {
    expect(upload).toContain("target_action: 'UPLOAD'");
    expect(upload).toContain("client.rpc(\n      'authorize_object_action'");
    expect(download).toContain("target_action: 'DOWNLOAD'");
    expect(download).toContain("client.rpc(\n      'authorize_object_action'");
  });

  it('binds the upload signature and final record to verified size, MIME, and checksum', () => {
    expect(upload).toContain('ChecksumSHA256: input.checksum_sha256');
    expect(upload).toContain("'x-amz-checksum-sha256': input.checksum_sha256");
    expect(finalize).toContain("ChecksumMode: 'ENABLED'");
    expect(finalize).toContain('head.ChecksumSHA256 !== intent.expected_checksum');
    expect(finalize).toContain("admin.rpc('finalize_object_upload'");
  });

  it('uses short-lived URLs and never returns storage credentials', () => {
    expect(upload).toContain('{ expiresIn: 10 * 60 }');
    expect(download).toContain('{ expiresIn: 5 * 60 }');
    expect(upload).not.toContain('TIGRIS_SECRET_ACCESS_KEY');
    expect(download).not.toContain('TIGRIS_SECRET_ACCESS_KEY');
  });

  it('keeps all object-storage functions behind Supabase JWT verification', () => {
    for (const functionName of ['presign-upload', 'object-upload-finalize', 'presign-download']) {
      expect(config).toContain(`[functions.${functionName}]\nverify_jwt = true`);
    }
  });
});
