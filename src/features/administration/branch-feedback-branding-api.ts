import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { isVersionConflictCode } from '../../lib/supabase/version-conflict';
import { AdministrationVersionConflictError } from './branch-team-query';

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

export const branchLogoMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Matches the cap set_branch_feedback_branding enforces. */
export const branchLogoMaxBytes = 2 * 1024 * 1024;

const brandingSchema = z.object({
  branch_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  brand_color: z.string().nullable(),
  logo_object_file_id: z.uuid().nullable(),
  google_review_url: z.string().nullable(),
});

export type BranchFeedbackBranding = z.infer<typeof brandingSchema>;
export type BranchLogoAction = 'KEEP' | 'REPLACE' | 'REMOVE';

export const branchFeedbackBrandingKey = (branchId: string) =>
  ['branch-feedback-branding', branchId] as const;
export const branchLogoPreviewKey = (objectFileId: string | null) =>
  ['branch-feedback-logo-preview', objectFileId ?? 'none'] as const;

export class BranchBrandingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BranchBrandingError';
  }
}

/** functions.invoke leaves `data` null on non-2xx; the envelope code is in the response body. */
async function edgeErrorCode(error: Error, fallback: string) {
  const response = (error as { context?: unknown }).context;
  if (!(response instanceof Response)) return fallback;
  try {
    const body = (await response.clone().json()) as EdgeEnvelope<unknown> | null;
    return body?.error?.code ?? fallback;
  } catch {
    return fallback;
  }
}

async function invokeEdge<T>(name: string, body: Record<string, unknown>, fallback: string) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<T>>(name, { body });
  if (error) throw new BranchBrandingError(await edgeErrorCode(error, fallback));
  if (!data?.ok || !data.data) throw new BranchBrandingError(data?.error?.code ?? fallback);
  return data.data;
}

async function sha256Base64(buffer: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function fetchBranchFeedbackBranding(branchId: string) {
  const { data, error } = await createClient().rpc('get_branch_feedback_branding', {
    target_branch_id: branchId,
  });
  if (error) throw error;
  return brandingSchema.parse(data);
}

export async function fetchBranchLogoPreview(objectFileId: string) {
  const result = await invokeEdge<{ download_url: string }>(
    'presign-download',
    { object_file_id: objectFileId },
    'LOGO_PREVIEW_FAILED',
  );
  return z.url().parse(result.download_url);
}

export function validateBranchLogo(file: File) {
  if (
    !(branchLogoMimeTypes as readonly string[]).includes(file.type) ||
    file.size < 1 ||
    file.size > branchLogoMaxBytes
  )
    throw new BranchBrandingError('LOGO_FILE_INVALID');
}

/**
 * Logos are stored as organization objects (branch_id null), which needs
 * document.upload and organization-wide scope. The branch link is made by
 * set_branch_feedback_branding, which only accepts an image the caller uploaded.
 */
export async function uploadBranchLogo(input: { organizationId: string; file: File }) {
  validateBranchLogo(input.file);
  const presign = await invokeEdge<{
    upload_intent_id: string;
    upload_url: string;
    required_headers: Record<string, string>;
  }>(
    'presign-upload',
    {
      organization_id: input.organizationId,
      branch_id: null,
      resource_type: 'organization',
      resource_id: input.organizationId,
      file_name: input.file.name,
      mime_type: input.file.type,
      size_bytes: input.file.size,
      checksum_sha256: await sha256Base64(await input.file.arrayBuffer()),
    },
    'LOGO_UPLOAD_FAILED',
  );
  const uploaded = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: presign.required_headers,
    body: input.file,
  }).catch(() => {
    throw new BranchBrandingError('LOGO_UPLOAD_FAILED');
  });
  if (!uploaded.ok) throw new BranchBrandingError('LOGO_UPLOAD_FAILED');
  const finalized = await invokeEdge<{ object_file_id: string }>(
    'object-upload-finalize',
    { upload_intent_id: presign.upload_intent_id },
    'LOGO_UPLOAD_FAILED',
  );
  return z.uuid().parse(finalized.object_file_id);
}

export async function saveBranchFeedbackBranding(input: {
  branchId: string;
  expectedVersion: number;
  brandColor: string | null;
  logoAction: BranchLogoAction;
  logoObjectFileId: string | null;
}) {
  const { data, error } = await createClient().rpc('set_branch_feedback_branding', {
    target_branch_id: input.branchId,
    expected_version: input.expectedVersion,
    target_brand_color: input.brandColor,
    target_logo_action: input.logoAction,
    target_logo_object_file_id: input.logoObjectFileId,
  });
  if (error) {
    if (isVersionConflictCode(error.code) || error.message?.includes('VERSION_CONFLICT'))
      throw new AdministrationVersionConflictError();
    for (const code of ['INVALID_BRAND_COLOR', 'INVALID_LOGO_FILE', 'BRANCH_NOT_FOUND'])
      if (error.message?.includes(code)) throw new BranchBrandingError(code);
    throw error;
  }
  return z.object({ version: z.coerce.number().int().positive() }).parse(data);
}

export function branchBrandingErrorMessage(error: unknown) {
  if (error instanceof AdministrationVersionConflictError)
    return 'This branch was changed by someone else. Close and reopen to load the latest version.';
  const code = error instanceof BranchBrandingError ? error.code : '';
  switch (code) {
    case 'LOGO_FILE_INVALID':
    case 'FILE_TYPE_OR_SIZE_NOT_ALLOWED':
      return 'Use a PNG, JPG or WebP logo of 2 MB or less.';
    case 'PERMISSION_DENIED':
      return 'Only an organization-wide administrator with document upload access can upload logos.';
    case 'INVALID_LOGO_FILE':
      return 'That logo could not be attached. Upload it again.';
    case 'INVALID_BRAND_COLOR':
      return 'Choose a colour in #RRGGBB form.';
    case 'BRANCH_NOT_FOUND':
      return 'This branch is not in your scope.';
    default:
      return 'The feedback page settings could not be saved. Try again in a moment.';
  }
}
