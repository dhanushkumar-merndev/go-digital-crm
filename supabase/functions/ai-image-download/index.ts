import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { tigrisClient } from '../_shared/tigris.ts';

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
      return failure('INVALID_PAYLOAD', 'The image output request is invalid.', requestId, 422);
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const admin = serviceClient();
    const { data: output } = await admin
      .from('ai_image_generation_outputs')
      .select(
        'object_file_id,ai_image_generations!inner(organization_id,branch_id),object_files!inner(bucket,object_key,mime_type)',
      )
      .eq('object_file_id', parsed.data.object_file_id)
      .maybeSingle();
    if (!output)
      return failure(
        'IMAGE_OUTPUT_NOT_FOUND',
        'The generated image was not found.',
        requestId,
        404,
      );
    const generation = output.ai_image_generations as unknown as {
      organization_id: string;
      branch_id: string | null;
    };
    const file = output.object_files as unknown as {
      bucket: string;
      object_key: string;
      mime_type: string;
    };
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: generation.organization_id,
      target_permission: 'marketing.social.manage',
      target_branch_id: generation.branch_id,
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot access this generated image.',
        requestId,
        403,
      );
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const downloadUrl = await getSignedUrl(
      tigrisClient(),
      new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        ResponseContentType: file.mime_type,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: 300 },
    );
    return success({ download_url: downloadUrl, expires_at: expiresAt }, requestId);
  } catch {
    return failure(
      'IMAGE_OUTPUT_PRESIGN_FAILED',
      'A secure image URL could not be created.',
      requestId,
      500,
    );
  }
});
