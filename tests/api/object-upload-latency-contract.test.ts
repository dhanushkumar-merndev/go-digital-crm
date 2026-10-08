import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const presign = readFileSync('supabase/functions/presign-upload/index.ts', 'utf8');
const finalize = readFileSync('supabase/functions/object-upload-finalize/index.ts', 'utf8');
const shared = readFileSync('supabase/functions/_shared/supabase.ts', 'utf8');
const profileApi = readFileSync('src/features/auth/profile-settings-api.ts', 'utf8');
const profileDialog = readFileSync('src/features/auth/profile-settings-dialog.tsx', 'utf8');

describe('object upload latency', () => {
  it('verifies the caller locally instead of an Auth server round trip', () => {
    expect(shared).toContain('export async function verifiedUserId(');
    expect(shared).toContain('client.auth.getClaims(token)');
    for (const handler of [presign, finalize]) {
      expect(handler).toContain('await verifiedUserId(client, request)');
      expect(handler).not.toContain('auth.getUser()');
    }
  });

  it('runs independent checks together and records nothing before they pass', () => {
    expect(presign).toContain('await Promise.all([');
    expect(presign.indexOf("'PERMISSION_DENIED'")).toBeLessThan(
      presign.indexOf("from('object_upload_intents').insert"),
    );
    expect(finalize).toContain(
      'const [{ data: context }, authorization, headRead] = await Promise.all([',
    );
    expect(finalize.indexOf("'PERMISSION_DENIED'")).toBeLessThan(
      finalize.indexOf("admin.rpc('finalize_object_upload'"),
    );
    expect(finalize.indexOf("'PERMISSION_DENIED'")).toBeLessThan(
      finalize.indexOf('if (headRead.failed) throw headRead.cause;'),
    );
  });

  it('skips only the avatar repeat of the access check its authorize RPC already makes', () => {
    for (const handler of [presign, finalize]) {
      expect(handler).toContain("data: { destination: 'CRM', organization_id:");
      expect(handler).toContain("client.rpc('authorize_profile_avatar_action'");
      expect(handler).toContain(": client.rpc('get_access_context')");
    }
  });

  it('presigns when the photo is chosen and reuses it on save', () => {
    expect(profileApi).toContain('const PRESIGN_REUSE_MS = 8 * 60_000;');
    expect(profileDialog).toContain('presignRef.current = presign;');
    expect(profileDialog).toContain('isPresignReusable(early, selectedFile)');
  });

  it('downsizes a profile photo when chosen and never enlarges it', () => {
    expect(profileApi).toContain('const AVATAR_MAX_EDGE_PX = 512;');
    expect(profileApi).toContain('blob.size >= file.size) return file;');
    expect(profileDialog).toContain('await prepareProfileAvatar(file)');
    expect(profileDialog).toContain('disabled={mutation.isPending || preparingPhoto}');
  });

  it('keeps the hidden photo input out of the dialog layout', () => {
    expect(profileDialog).toContain('className="hidden"');
    expect(profileDialog).not.toContain('className="sr-only"');
  });
});
