import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { attachmentDisposition, safeObjectFileName, tigrisClient } from '../_shared/tigris.ts';

const schema = z.object({ object_file_id: z.uuid() });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The download request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const admin = serviceClient();
    const { data: file } = await admin
      .from('object_files')
      .select(
        'id,organization_id,branch_id,resource_type,resource_id,bucket,object_key,original_file_name,mime_type,size_bytes',
      )
      .eq('id', parsed.data.object_file_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (!file) return failure('OBJECT_FILE_NOT_FOUND', 'The file was not found.', requestId, 404);
    const { data: context } = await client.rpc('get_access_context');
    const platformReviewer =
      context?.destination === 'CRM' &&
      context?.role_key === 'super-admin' &&
      context?.mfa_satisfied === true;
    if (
      !context ||
      context.destination !== 'CRM' ||
      (!platformReviewer && context.organization_id !== file.organization_id)
    )
      return failure('ACCESS_NOT_READY', 'CRM access is not available.', requestId, 403);
    let authorized: boolean | null = null;
    let authorizationError: unknown = null;
    if (file.resource_type === 'report_export') {
      const result = await client.rpc('authorize_report_export_download', {
        target_export_id: file.resource_id,
      });
      authorized = result.data;
      authorizationError = result.error;
    } else {
      const result = await client.rpc('authorize_object_action', {
        target_organization_id: file.organization_id,
        target_branch_id: file.branch_id,
        target_resource_type: file.resource_type,
        target_resource_id: file.resource_id,
        target_action: 'DOWNLOAD',
      });
      authorized = result.data;
      authorizationError = result.error;
    }
    if (authorizationError || !authorized)
      return failure('PERMISSION_DENIED', 'You cannot download this file.', requestId, 403);

    const fileName = safeObjectFileName(file.original_file_name || `${file.id}.bin`);
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const downloadUrl = await getSignedUrl(
      tigrisClient(),
      new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        ResponseContentType: file.mime_type,
        ResponseContentDisposition: attachmentDisposition(fileName),
      }),
      { expiresIn: 5 * 60 },
    );
    return success(
      {
        download_url: downloadUrl,
        expires_at: expiresAt,
        file_name: fileName,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
      },
      requestId,
    );
  } catch {
    return failure(
      'DOWNLOAD_PRESIGN_FAILED',
      'A secure download URL could not be created.',
      requestId,
      500,
    );
  }
});
