import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const migration = source('supabase/migrations/202608250002_self_service_profile_settings.sql');
const upload = source('supabase/functions/presign-upload/index.ts');
const finalize = source('supabase/functions/object-upload-finalize/index.ts');
const avatarUrl = source('supabase/functions/profile-avatar-url/index.ts');
const config = source('supabase/config.toml');
const header = source('src/components/shared/app-header.tsx');
const profileApi = source('src/features/auth/profile-settings-api.ts');
const profileDialog = source('src/features/auth/profile-settings-dialog.tsx');
const bootstrap = source('src/lib/auth/workspace-bootstrap.ts');
const session = source('src/components/providers/workspace-session-provider.tsx');

function migrationSection(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('self-service profile settings contract', () => {
  it('stores only a tenant-scoped object-file reference and closes the direct update path', () => {
    expect(migration).toContain('add column if not exists avatar_object_file_id uuid');
    expect(migration).toContain('profiles_avatar_object_file_org_fk');
    expect(migration).toContain('references public.object_files (organization_id, id)');
    expect(migration).toContain('drop policy if exists profiles_update on public.profiles');
    expect(migration).toContain('revoke update on public.profiles from anon, authenticated');
    expect(migration).toContain('profile_self_update_request_unique_idx');
  });

  it('allows avatar uploads only for the active caller and their own CRM profile', () => {
    const authorization = migrationSection(
      'create or replace function public.authorize_profile_avatar_action',
      'create or replace function public.update_my_profile',
    );
    expect(authorization).toContain("target_action not in ('UPLOAD', 'DOWNLOAD')");
    expect(authorization).toContain('target_profile_id <> auth.uid()');
    expect(authorization).toContain("access_context ->> 'destination' <> 'CRM'");
    expect(authorization).toContain('profile_row.organization_id = target_organization_id');
    expect(authorization).toContain('profile_row.active');
    expect(authorization).toContain('profile_row.deleted_at is null');
    expect(authorization).not.toContain("'document.upload'");
  });

  it('uses one narrow, versioned and audited mutation for name and avatar changes', () => {
    const update = migrationSection(
      'create or replace function public.update_my_profile',
      '-- The bootstrap payload contains only an opaque object-file ID.',
    );
    expect(update).toContain('expected_version bigint');
    expect(update).toContain('target_request_id uuid');
    expect(update).toContain("normalized_avatar_action not in ('KEEP', 'REPLACE', 'REMOVE')");
    expect(update).toContain("message = 'INVALID_PROFILE_NAME'");
    expect(update).toContain('for update');
    expect(update).toContain('current_profile.version <> expected_version');
    expect(update).toContain("message = 'STALE_PROFILE_VERSION'");
    expect(update).toContain("object_file_row.resource_type = 'profile'");
    expect(update).toContain('object_file_row.resource_id = auth.uid()');
    expect(update).toContain('object_file_row.uploaded_by = auth.uid()');
    expect(update).toContain('object_file_row.branch_id is null');
    expect(update).toContain(
      "object_file_row.mime_type in ('image/jpeg', 'image/png', 'image/webp')",
    );
    expect(update).toContain("'profile.self_updated'");
    expect(update).toContain("'full_name_changed', name_changed");
    expect(update).toContain("'avatar_changed', avatar_changed");
    expect(update).toContain('set deleted_at = coalesce(object_file_row.deleted_at, now())');
    expect(update).not.toMatch(/delete\s+from\s+public\.(profiles|object_files)/i);
  });

  it('keeps bootstrap private while making the opaque avatar reference available to the shell', () => {
    const bootstrapFunction = migrationSection(
      'create or replace function public.get_workspace_bootstrap()',
      'revoke all on function public.authorize_profile_avatar_action',
    );
    expect(bootstrapFunction).toContain(
      "'avatar_object_file_id', profile_row.avatar_object_file_id",
    );
    expect(bootstrapFunction).toContain("'profile_version', profile_row.version");
    expect(bootstrapFunction).not.toContain('object_key');
    expect(bootstrapFunction).not.toContain('download_url');
    expect(bootstrapFunction).not.toContain('avatar_url');
    expect(bootstrap).toContain('avatar_object_file_id: z.uuid().nullable().optional()');
    expect(bootstrap).toContain('profile_version: z.coerce.number().int().positive().optional()');
    expect(session).toContain('avatarObjectFileId: string | null');
    expect(session).toContain('profileVersion: number');
  });
});

describe('private profile-avatar transport contract', () => {
  it('uses the established signed-upload/finalize flow with stricter avatar limits', () => {
    expect(upload).toContain("'profile',");
    expect(upload).toContain('const profileAvatarMimeSizes');
    expect(upload).toContain("['image/jpeg', 5 * 1024 * 1024]");
    expect(upload).toContain("['image/png', 5 * 1024 * 1024]");
    expect(upload).toContain("['image/webp', 5 * 1024 * 1024]");
    expect(upload).toContain('PROFILE_AVATAR_BRANCH_NOT_ALLOWED');
    expect(upload).toContain("client.rpc('authorize_profile_avatar_action'");
    expect(finalize).toContain("intent.resource_type === 'profile'");
    expect(finalize).toContain("client.rpc('authorize_profile_avatar_action'");
    expect(profileApi).toContain("resource_type: 'profile'");
    expect(profileApi).toContain("'object-upload-finalize'");
    expect(profileApi).toContain('checksum_sha256: checksum');
    expect(profileApi).toContain('headers: presign.required_headers');
    expect(profileApi).toContain('supabase.auth.getSession()');
    expect(profileApi).toContain('Authorization: `Bearer ${data.session.access_token}`');
  });

  it('returns a short-lived inline URL only for the caller current avatar', () => {
    expect(avatarUrl).toContain("context.destination !== 'CRM'");
    expect(avatarUrl).toContain(".eq('id', auth.user.id)");
    expect(avatarUrl).toContain(".eq('resource_type', 'profile')");
    expect(avatarUrl).toContain(".eq('resource_id', auth.user.id)");
    expect(avatarUrl).toContain(".eq('uploaded_by', auth.user.id)");
    expect(avatarUrl).toContain("ResponseContentDisposition: 'inline'");
    expect(avatarUrl).toContain('{ expiresIn: 5 * 60 }');
    expect(avatarUrl).not.toContain('TIGRIS_SECRET_ACCESS_KEY');
    expect(config).toMatch(/\[functions\.profile-avatar-url\]\s+verify_jwt\s*=\s*true/);
  });
});

describe('profile settings workspace contract', () => {
  it('uses a shadcn dialog and TanStack Query from the account menu', () => {
    expect(header).toContain('My profile');
    expect(header).toContain('ProfileSettingsDialog');
    expect(header).toContain('AvatarImage');
    expect(header).toContain('fetchProfileAvatarUrl');
    expect(header).toContain('router.refresh()');
    expect(profileDialog).toContain("from '@tanstack/react-query'");
    expect(profileDialog).toContain('<Dialog');
    expect(profileDialog).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(profileDialog).toContain('Save profile');
    expect(profileApi).toContain("rpc('update_my_profile'");
    expect(profileApi).toContain("'profile-avatar-url'");
  });
});
