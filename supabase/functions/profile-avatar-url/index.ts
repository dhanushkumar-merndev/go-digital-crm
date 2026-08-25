import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { tigrisClient } from '../_shared/tigris.ts';

const schema = z.object({}).strict();
const allowedAvatarMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The profile image request is invalid.', requestId, 422);

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);

    const { data: context } = await client.rpc('get_access_context');
    if (!context || context.destination !== 'CRM' || !context.organization_id)
      return failure('ACCESS_NOT_READY', 'CRM access is not available.', requestId, 403);

    const admin = serviceClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('organization_id,avatar_object_file_id,active,deleted_at')
      .eq('id', auth.user.id)
      .maybeSingle();
    if (
      !profile ||
      !profile.active ||
      profile.deleted_at ||
      profile.organization_id !== context.organization_id ||
      !profile.avatar_object_file_id
    )
      return failure('PROFILE_AVATAR_NOT_FOUND', 'A profile image was not found.', requestId, 404);

    const { data: objectFile } = await admin
      .from('object_files')
      .select('bucket,object_key,mime_type,size_bytes')
      .eq('id', profile.avatar_object_file_id)
      .eq('organization_id', profile.organization_id)
      .is('branch_id', null)
      .eq('resource_type', 'profile')
      .eq('resource_id', auth.user.id)
      .eq('uploaded_by', auth.user.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (
      !objectFile ||
      !allowedAvatarMimes.has(objectFile.mime_type) ||
      objectFile.size_bytes < 1 ||
      objectFile.size_bytes > 5 * 1024 * 1024
    )
      return failure('PROFILE_AVATAR_NOT_FOUND', 'A profile image was not found.', requestId, 404);

    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const avatarUrl = await getSignedUrl(
      tigrisClient(),
      new GetObjectCommand({
        Bucket: objectFile.bucket,
        Key: objectFile.object_key,
        ResponseContentType: objectFile.mime_type,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: 5 * 60 },
    );
    return success({ avatar_url: avatarUrl, expires_at: expiresAt }, requestId);
  } catch {
    return failure(
      'PROFILE_AVATAR_PRESIGN_FAILED',
      'The profile image could not be loaded.',
      requestId,
      500,
    );
  }
});
