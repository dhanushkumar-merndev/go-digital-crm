import { HeadObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient, verifiedUserId } from '../_shared/supabase.ts';
import { tigrisClient } from '../_shared/tigris.ts';

const schema = z.object({ upload_intent_id: z.uuid() });

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure(
        'INVALID_PAYLOAD',
        'The upload finalization request is invalid.',
        requestId,
        422,
      );
    const client = authenticatedClient(request);
    const userId = await verifiedUserId(client, request);
    if (!userId) return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const admin = serviceClient();
    const { data: intent } = await admin
      .from('object_upload_intents')
      .select(
        'id,organization_id,branch_id,resource_type,resource_id,bucket,object_key,expected_mime_type,expected_size_bytes,expected_checksum,requested_by,expires_at,object_file_id',
      )
      .eq('id', parsed.data.upload_intent_id)
      .maybeSingle();
    if (!intent || intent.requested_by !== userId)
      return failure('UPLOAD_INTENT_NOT_FOUND', 'The upload intent was not found.', requestId, 404);
    if (intent.object_file_id)
      return success({ object_file_id: intent.object_file_id, duplicate: true }, requestId);
    if (new Date(intent.expires_at).getTime() <= Date.now())
      return failure('UPLOAD_INTENT_EXPIRED', 'The upload request has expired.', requestId, 410);

    // The access context, authorization and storage metadata read are
    // independent. The object is only recorded after all of them succeed.
    // authorize_profile_avatar_action already applies the CRM-destination and
    // organization check from get_access_context, so avatars skip the repeat.
    const [{ data: context }, authorization, headRead] = await Promise.all([
      intent.resource_type === 'profile'
        ? Promise.resolve({
            data: { destination: 'CRM', organization_id: intent.organization_id },
          })
        : client.rpc('get_access_context'),
      intent.resource_type === 'profile'
        ? client.rpc('authorize_profile_avatar_action', {
            target_organization_id: intent.organization_id,
            target_profile_id: intent.resource_id,
            target_action: 'UPLOAD',
          })
        : client.rpc('authorize_object_action', {
            target_organization_id: intent.organization_id,
            target_branch_id: intent.branch_id,
            target_resource_type: intent.resource_type,
            target_resource_id: intent.resource_id,
            target_action: 'UPLOAD',
          }),
      tigrisClient()
        .send(
          new HeadObjectCommand({
            Bucket: intent.bucket,
            Key: intent.object_key,
            ChecksumMode: 'ENABLED',
          }),
        )
        // Held until the permission answer, so a refusal still reads as 403.
        .then(
          (result) => ({ result, failed: false as const }),
          (cause: unknown) => ({ cause, failed: true as const }),
        ),
    ]);
    if (
      !context ||
      context.destination !== 'CRM' ||
      context.organization_id !== intent.organization_id
    )
      return failure('ACCESS_NOT_READY', 'CRM access is not available.', requestId, 403);
    if (authorization.error || !authorization.data)
      return failure('PERMISSION_DENIED', 'You cannot finalize this upload.', requestId, 403);
    if (headRead.failed) throw headRead.cause;
    const head = headRead.result;
    if (
      head.ContentLength !== intent.expected_size_bytes ||
      head.ContentType?.toLowerCase() !== intent.expected_mime_type.toLowerCase() ||
      head.ChecksumSHA256 !== intent.expected_checksum
    )
      return failure(
        'UPLOADED_OBJECT_MISMATCH',
        'The uploaded object did not match the approved file.',
        requestId,
        409,
      );
    const { data: objectFileId, error: finalizeError } = await admin.rpc('finalize_object_upload', {
      target_intent_id: intent.id,
      actual_size_bytes: head.ContentLength,
      actual_mime_type: head.ContentType,
      actual_checksum: head.ChecksumSHA256,
    });
    if (finalizeError) throw finalizeError;
    return success({ object_file_id: objectFileId, duplicate: false }, requestId, 201);
  } catch {
    return failure(
      'UPLOAD_FINALIZE_FAILED',
      'The uploaded file could not be finalized.',
      requestId,
      500,
    );
  }
});
