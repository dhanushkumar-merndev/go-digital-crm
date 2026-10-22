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

/**
 * `functions.invoke` reports any non-2xx as `error` with `data` left null, so
 * the envelope this used to read was never populated on the failing path and
 * every edge refusal collapsed into `PROFILE_REQUEST_FAILED`. The real code
 * lives in the `FunctionsHttpError` response body, so read it from there.
 */
async function edgeEnvelopeError(error: Error) {
  const response = (error as { context?: unknown }).context;
  if (!(response instanceof Response)) return null;
  try {
    const body = (await response.clone().json()) as EdgeEnvelope<unknown> | null;
    if (!body?.error?.code) return null;
    return new ProfileSettingsError(body.error.code, body.error.message);
  } catch {
    return null;
  }
}

async function throwEdgeError<T>(result: { data: EdgeEnvelope<T> | null; error: Error | null }) {
  if (result.error) {
    throw (
      (await edgeEnvelopeError(result.error)) ??
      new ProfileSettingsError('PROFILE_REQUEST_FAILED', result.error.message)
    );
  }
  if (!result.data?.ok || !result.data.data) {
    throw new ProfileSettingsError(
      result.data?.error?.code ?? 'PROFILE_REQUEST_FAILED',
      result.data?.error?.message,
    );
  }
  return result.data.data;
}

async function invokeAuthenticatedEdge<T>(
  supabase: ReturnType<typeof createClient>,
  functionName: 'presign-upload' | 'object-upload-finalize' | 'profile-avatar-url',
  body: Record<string, unknown>,
) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new ProfileSettingsError(
      'AUTHENTICATION_REQUIRED',
      error?.message ?? 'Authentication is required.',
    );
  }

  // Edge Functions require the signed-in user's JWT in Authorization. Passing
  // it explicitly prevents a legacy anon JWT from becoming the Bearer fallback
  // when the browser session is still initializing or has expired.
  return supabase.functions.invoke<T>(functionName, {
    body,
    headers: { Authorization: `Bearer ${data.session.access_token}` },
  });
}

export function validateProfileAvatar(file: File) {
  if (!avatarMimeTypes.has(file.type) || file.size < 1 || file.size > maxAvatarBytes) {
    throw new ProfileSettingsError('PROFILE_AVATAR_INVALID');
  }
}

/** Avatars render at 80 px at most; 512 px stays sharp on high-density screens. */
const AVATAR_MAX_EDGE_PX = 512;

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Downscale a chosen photo before upload. A phone photo is 2–5 MB and took
 * seconds to send for an image shown at 80 px; the resized WebP is usually
 * under 100 KB. Any failure, or a result no smaller than the original, keeps
 * the original file, so this can only make an upload smaller.
 */
export async function prepareProfileAvatar(file: File): Promise<File> {
  validateProfileAvatar(file);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AVATAR_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // Browsers without a WebP encoder return PNG for this request; fall back to JPEG.
    let blob = await canvasBlob(canvas, 'image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', 0.85);
    if (!blob || !avatarMimeTypes.has(blob.type) || blob.size >= file.size) return file;
    const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'avatar';
    return new File([blob], `${baseName}.${extension}`, { type: blob.type });
  } catch {
    return file;
  }
}

export type PresignedProfileAvatar = {
  file: File;
  uploadIntentId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  /** Client clock; the server-side intent and URL last ten minutes. */
  presignedAt: number;
};

// Re-presign comfortably before the ten-minute intent and URL expire.
const PRESIGN_REUSE_MS = 8 * 60_000;

/**
 * Reserve the upload for an already-prepared file. The dialog calls this as
 * soon as a photo is chosen, so Save does not wait on it. An abandoned
 * presign leaves only an expiring intent row: nothing is written to storage.
 */
export async function presignProfileAvatar(input: {
  organizationId: string;
  userId: string;
  file: File;
}): Promise<PresignedProfileAvatar> {
  if (!hasSupabaseConfig()) throw new ProfileSettingsError('SUPABASE_NOT_CONFIGURED');
  validateProfileAvatar(input.file);

  const supabase = createClient();
  const checksum = await sha256Base64(await input.file.arrayBuffer());
  const presign = await throwEdgeError(
    await invokeAuthenticatedEdge<
      EdgeEnvelope<{
        upload_intent_id: string;
        upload_url: string;
        required_headers: Record<string, string>;
      }>
    >(supabase, 'presign-upload', {
      organization_id: input.organizationId,
      branch_id: null,
      resource_type: 'profile',
      resource_id: input.userId,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: checksum,
    }),
  );
  return {
    file: input.file,
    uploadIntentId: presign.upload_intent_id,
    uploadUrl: presign.upload_url,
    requiredHeaders: presign.required_headers,
    presignedAt: Date.now(),
  };
}

export function isPresignReusable(presigned: PresignedProfileAvatar, file: File) {
  return presigned.file === file && Date.now() - presigned.presignedAt < PRESIGN_REUSE_MS;
}

/** Send the prepared file to storage and record it; returns the object_files id. */
export async function completeProfileAvatarUpload(presigned: PresignedProfileAvatar) {
  const upload = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: presigned.requiredHeaders,
    body: presigned.file,
  }).catch((cause: unknown) => {
    throw new ProfileSettingsError(
      'PROFILE_AVATAR_NETWORK_BLOCKED',
      cause instanceof Error ? cause.message : 'Storage upload request was blocked.',
    );
  });
  if (!upload.ok)
    throw new ProfileSettingsError(
      'PROFILE_AVATAR_UPLOAD_FAILED',
      `Storage rejected the upload with ${upload.status}.`,
    );

  const finalized = await throwEdgeError(
    await invokeAuthenticatedEdge<EdgeEnvelope<{ object_file_id: string }>>(
      createClient(),
      'object-upload-finalize',
      { upload_intent_id: presigned.uploadIntentId },
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

  const parsed = savedProfileSchema.safeParse(data);
  if (!parsed.success)
    throw new ProfileSettingsError(
      'PROFILE_RESPONSE_UNEXPECTED',
      `update_my_profile returned ${JSON.stringify(data)}`,
    );
  const saved = parsed.data;
  return {
    fullName: saved.full_name,
    avatarObjectFileId: saved.avatar_object_file_id,
    version: saved.version,
  } satisfies SavedProfile;
}

type ProfileAvatarUrl = z.infer<typeof avatarUrlSchema>;

/** A signed URL is reused only while it has at least this long left to live. */
const AVATAR_URL_MIN_REMAINING_MS = 60_000;
const avatarUrlStorageKey = (avatarObjectFileId: string) =>
  `gdm-profile-avatar-url:${avatarObjectFileId}`;

/**
 * The header's signed avatar URL from this tab's session storage, while it is
 * still inside its own five-minute life. Every full page load used to presign
 * again (an Edge call of up to a second); the URL is never kept past its
 * expiry and never written to IndexedDB.
 */
export function readCachedProfileAvatarUrl(avatarObjectFileId: string | null) {
  if (!avatarObjectFileId) return undefined;
  try {
    const parsed = avatarUrlSchema.safeParse(
      JSON.parse(sessionStorage.getItem(avatarUrlStorageKey(avatarObjectFileId)) ?? 'null'),
    );
    if (!parsed.success) return undefined;
    const remaining = new Date(parsed.data.expires_at).getTime() - Date.now();
    return remaining > AVATAR_URL_MIN_REMAINING_MS ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchProfileAvatarUrl(
  avatarObjectFileId: string | null = null,
): Promise<ProfileAvatarUrl> {
  if (!hasSupabaseConfig()) throw new ProfileSettingsError('SUPABASE_NOT_CONFIGURED');
  const supabase = createClient();
  const result = await throwEdgeError(
    await invokeAuthenticatedEdge<EdgeEnvelope<ProfileAvatarUrl>>(
      supabase,
      'profile-avatar-url',
      {},
    ),
  );
  const avatar = avatarUrlSchema.parse(result);
  if (avatarObjectFileId)
    try {
      sessionStorage.setItem(avatarUrlStorageKey(avatarObjectFileId), JSON.stringify(avatar));
    } catch {
      /* Storage blocked: the next load presigns again. */
    }
  return avatar;
}

export function getProfileSettingsErrorMessage(error: unknown) {
  if (!(error instanceof ProfileSettingsError))
    return 'Your profile could not be updated. Please try again. (UNEXPECTED_CLIENT_ERROR)';
  const code = error.code;
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
    case 'UNAUTHENTICATED':
    case 'CRM_ACCESS_REQUIRED':
    case 'PROFILE_ACCESS_REQUIRED':
      return 'Your session is no longer signed in to this workspace. Sign in again and retry.';
    case 'INVALID_PROFILE_UPDATE':
    case 'INVALID_PROFILE_AVATAR_ACTION':
      return 'This profile form is out of date. Refresh the page and try again.';
    case 'PROFILE_AVATAR_UPLOAD_FAILED':
      return 'The photo could not be uploaded. Check your connection and try again.';
    case 'PROFILE_AVATAR_NETWORK_BLOCKED':
      return 'The photo upload was blocked before it reached storage. This is usually a storage CORS rule that does not allow a PUT from this site.';
    case 'PGRST202':
      return 'The profile update function is missing from the database. The self-service profile migration has not been applied to this project.';
    case 'PROFILE_RESPONSE_UNEXPECTED':
      return 'The profile was saved but the response could not be read. Refresh the page to see the current values.';
    case 'MFA_REQUIRED':
      return 'Complete multi-factor verification before updating your profile.';
    case 'SUPABASE_NOT_CONFIGURED':
      return 'Profile updates are unavailable until Supabase is configured.';
    default:
      // An unnamed failure is the one a user cannot act on and support cannot
      // reproduce, so the code travels with the message instead of being lost.
      return `Your profile could not be updated. Please try again. (${code || 'UNKNOWN'})`;
  }
}
