import { PutObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { safeObjectFileName, tigrisBucket, tigrisClient } from '../_shared/tigris.ts';

const allowedMimeSizes = new Map<string, number>([
  ['application/pdf', 25 * 1024 * 1024],
  ['application/msword', 25 * 1024 * 1024],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 25 * 1024 * 1024],
  ['application/vnd.ms-excel', 25 * 1024 * 1024],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 25 * 1024 * 1024],
  ['image/jpeg', 25 * 1024 * 1024],
  ['image/png', 25 * 1024 * 1024],
  ['image/webp', 25 * 1024 * 1024],
  ['image/heic', 25 * 1024 * 1024],
  ['audio/mpeg', 100 * 1024 * 1024],
  ['audio/wav', 100 * 1024 * 1024],
  ['audio/ogg', 100 * 1024 * 1024],
  ['video/mp4', 250 * 1024 * 1024],
  ['text/plain', 5 * 1024 * 1024],
]);

const schema = z.object({
  organization_id: z.uuid(),
  branch_id: z.uuid().nullable().optional(),
  resource_type: z.enum([
    'organization',
    'customer',
    'lead',
    'call',
    'appointment',
    'test_drive',
    'quotation',
    'booking',
    'stock_unit',
    'exchange_case',
    'finance_case',
    'insurance_case',
    'rto_case',
    'delivery_case',
  ]),
  resource_id: z.uuid(),
  file_name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value)),
  mime_type: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase()),
  size_bytes: z.int().positive(),
  checksum_sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The upload request is invalid.', requestId, 422);
    const input = parsed.data;
    const maximumBytes = allowedMimeSizes.get(input.mime_type);
    if (!maximumBytes || input.size_bytes > maximumBytes)
      return failure(
        'FILE_TYPE_OR_SIZE_NOT_ALLOWED',
        'The selected file type or size is not allowed.',
        requestId,
        422,
      );

    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: context } = await client.rpc('get_access_context');
    if (
      !context ||
      context.destination !== 'CRM' ||
      context.organization_id !== input.organization_id
    )
      return failure('ACCESS_NOT_READY', 'CRM access is not available.', requestId, 403);
    const { data: authorized, error: authorizationError } = await client.rpc(
      'authorize_object_action',
      {
        target_organization_id: input.organization_id,
        target_branch_id: input.branch_id ?? null,
        target_resource_type: input.resource_type,
        target_resource_id: input.resource_id,
        target_action: 'UPLOAD',
      },
    );
    if (authorizationError || !authorized)
      return failure('PERMISSION_DENIED', 'You cannot upload to this record.', requestId, 403);

    const intentId = crypto.randomUUID();
    const safeFileName = safeObjectFileName(input.file_name);
    const objectKey = `${input.organization_id}/${input.resource_type}/${input.resource_id}/${intentId}-${safeFileName}`;
    const bucket = tigrisBucket();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const admin = serviceClient();
    const { error: intentError } = await admin.from('object_upload_intents').insert({
      id: intentId,
      organization_id: input.organization_id,
      branch_id: input.branch_id ?? null,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      bucket,
      object_key: objectKey,
      file_name: safeFileName,
      expected_mime_type: input.mime_type,
      expected_size_bytes: input.size_bytes,
      expected_checksum: input.checksum_sha256,
      requested_by: auth.user.id,
      expires_at: expiresAt,
    });
    if (intentError) throw intentError;

    const uploadUrl = await getSignedUrl(
      tigrisClient(),
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentLength: input.size_bytes,
        ContentType: input.mime_type,
        ChecksumSHA256: input.checksum_sha256,
      }),
      { expiresIn: 10 * 60 },
    );
    return success(
      {
        upload_intent_id: intentId,
        upload_url: uploadUrl,
        method: 'PUT',
        required_headers: {
          'content-type': input.mime_type,
          'x-amz-checksum-sha256': input.checksum_sha256,
        },
        expires_at: expiresAt,
      },
      requestId,
      201,
    );
  } catch {
    return failure(
      'UPLOAD_PRESIGN_FAILED',
      'A secure upload URL could not be created.',
      requestId,
      500,
    );
  }
});
