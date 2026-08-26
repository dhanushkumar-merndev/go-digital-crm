import { z } from 'zod';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

const avatarMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxAvatarBytes = 5 * 1024 * 1024;

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

const savedProfileSchema = z.object({
  full_name: z.string().trim().min(2).max(160),
  avatar_object_file_id: z.uuid().nullable(),
  version: z.coerce.number().int().positive(),
});

const avatarUrlSchema = z.object({
  avatar_url: z.url(),
  expires_at: z.string(),
});

export type SavedProfile = {
  fullName: string;
  avatarObjectFileId: string | null;
  version: number;
};

export type ProfileAvatarAction = 'KEEP' | 'REPLACE' | 'REMOVE';

export const profileAvatarUrlKey = (avatarObjectFileId: string | null) =>
  ['profile-avatar-url', avatarObjectFileId ?? 'none'] as const;

export class ProfileSettingsError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ProfileSettingsError';
  }
}

function sha256Base64(buffer: ArrayBuffer) {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) => {
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

function throwEdgeError<T>(result: { data: EdgeEnvelope<T> | null; error: Error | null }) {
  if (result.error || !result.data?.ok || !result.data.data) {
    throw new ProfileSettingsError(
      result.data?.error?.code ?? 'PROFILE_REQUEST_FAILED',
      result.data?.error?.message,
    );
  }
  return result.data.data;
}

export function validateProfileAvatar(file: File) {
  if (!avatarMimeTypes.has(file.type) || file.size < 1 || file.size > maxAvatarBytes) {
    throw new ProfileSettingsError('PROFILE_AVATAR_INVALID');
  }
}

export async function uploadProfileAvatar(input: {
  organizationId: string;
  userId: string;
  file: File;
}) {
  if (!hasSupabaseConfig()) throw new ProfileSettingsError('SUPABASE_NOT_CONFIGURED');
  validateProfileAvatar(input.file);

  const supabase = createClient();
  const checksum = await sha256Base64(await input.file.arrayBuffer());
  const presign = throwEdgeError(
    await supabase.functions.invoke<
      EdgeEnvelope<{
        upload_intent_id: string;
        upload_url: string;
        required_headers: Record<string, string>;
      }>
    >('presign-upload', {
      body: {
        organization_id: input.organizationId,
        branch_id: null,
        resource_type: 'profile',
        resource_id: input.userId,
        file_name: input.file.name,
        mime_type: input.file.type,
        size_bytes: input.file.size,
        checksum_sha256: checksum,
      },
    }),
  );

  const upload = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: presign.required_headers,
    body: input.file,
  });
  if (!upload.ok) throw new ProfileSettingsError('PROFILE_AVATAR_UPLOAD_FAILED');

  const finalized = throwEdgeError(
    await supabase.functions.invoke<EdgeEnvelope<{ object_file_id: string }>>(
      'object-upload-finalize',
      { body: { upload_intent_id: presign.upload_intent_id } },
    ),
  );
  return z.uuid().parse(finalized.object_file_id);
}

/**
 * `update_my_profile` reports its refusals as `raise exception using message =
 * 'STALE_PROFILE_VERSION'`, so the domain reason arrives in PostgREST's
 * `message`; `code` only ever carries the SQLSTATE. Reading `code` therefore
 * matched none of the cases below and every refusal — a stale version, a name
 * that failed validation, an MFA gate — surfaced as the same "please try again"
 * banner, which is exactly the failure a user cannot act on.
 */
const profileErrorCodes = new Set([
  'AUTHENTICATION_REQUIRED',
  'CRM_ACCESS_REQUIRED',
  'INVALID_PROFILE_AVATAR_ACTION',
  'INVALID_PROFILE_NAME',
  'INVALID_PROFILE_UPDATE',
  'MFA_REQUIRED',
  'PROFILE_ACCESS_REQUIRED',
  'PROFILE_AVATAR_NOT_OWNED',
  'PROFILE_AVATAR_ORGANIZATION_REQUIRED',
  'STALE_PROFILE_VERSION',
]);

function postgrestErrorCode(error: { message?: string | null; code?: string | null }) {
  const message = (error.message ?? '').trim();
  for (const code of profileErrorCodes) if (message.includes(code)) return code;
  return error.code ?? 'PROFILE_UPDATE_FAILED';
}

export async function saveMyProfile(input: {
  fullName: string;
  expectedVersion: number;
  avatarAction: ProfileAvatarAction;
  avatarObjectFileId: string | null;
}) {
  if (!hasSupabaseConfig()) throw new ProfileSettingsError('SUPABASE_NOT_CONFIGURED');

  const { data, error } = await createClient().rpc('update_my_profile', {
    target_full_name: input.fullName.trim(),
    expected_version: input.expectedVersion,
    target_request_id: crypto.randomUUID(),
    target_avatar_action: input.avatarAction,
    target_avatar_object_file_id: input.avatarObjectFileId,
  });
  if (error) throw new ProfileSettingsError(postgrestErrorCode(error), error.message);

  const saved = savedProfileSchema.parse(data);
  return {
    fullName: saved.full_name,
    avatarObjectFileId: saved.avatar_object_file_id,
    version: saved.version,
  } satisfies SavedProfile;
}

export async function fetchProfileAvatarUrl() {
  if (!hasSupabaseConfig()) throw new ProfileSettingsError('SUPABASE_NOT_CONFIGURED');
  const result = throwEdgeError(
    await createClient().functions.invoke<EdgeEnvelope<z.infer<typeof avatarUrlSchema>>>(
      'profile-avatar-url',
      { body: {} },
    ),
  );
  return avatarUrlSchema.parse(result);
}

export function getProfileSettingsErrorMessage(error: unknown) {
  const code = error instanceof ProfileSettingsError ? error.code : '';
  switch (code) {
    case 'PROFILE_AVATAR_INVALID':
    case 'FILE_TYPE_OR_SIZE_NOT_ALLOWED':
      return 'Choose a JPEG, PNG or WebP image no larger than 5 MB.';
    case 'STALE_PROFILE_VERSION':
      return 'Your profile changed elsewhere. Refresh the page and try again.';
    case 'PROFILE_AVATAR_NOT_OWNED':
    case 'PROFILE_AVATAR_ORGANIZATION_REQUIRED':
      return 'That profile image is not available for this account.';
    case 'INVALID_PROFILE_NAME':
      return 'Enter a display name between 2 and 160 characters.';
    case 'AUTHENTICATION_REQUIRED':
    case 'CRM_ACCESS_REQUIRED':
    case 'PROFILE_ACCESS_REQUIRED':
      return 'Your session is no longer signed in to this workspace. Sign in again and retry.';
    case 'INVALID_PROFILE_UPDATE':
    case 'INVALID_PROFILE_AVATAR_ACTION':
      return 'This profile form is out of date. Refresh the page and try again.';
    case 'PROFILE_AVATAR_UPLOAD_FAILED':
      return 'The photo could not be uploaded. Check your connection and try again.';
    case 'MFA_REQUIRED':
      return 'Complete multi-factor verification before updating your profile.';
    case 'SUPABASE_NOT_CONFIGURED':
      return 'Profile updates are unavailable until Supabase is configured.';
    default:
      return 'Your profile could not be updated. Please try again.';
  }
}
