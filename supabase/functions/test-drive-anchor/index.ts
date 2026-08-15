import { z } from 'npm:zod@4';
import { failure, preflight, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  test_drive_id: z.uuid(),
  kind: z.enum(['start', 'reached', 'end']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  recorded_at: z.iso.datetime(),
  odometer: z.int().nonnegative().optional(),
  expected_version: z.int().positive(),
  request_id: z.uuid(),
});
Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Test-drive anchor is invalid.', requestId, 422);
    const input = parsed.data;
    const { data, error } = await authenticatedClient(request).rpc('record_test_drive_anchor_v2', {
      target_test_drive_id: input.test_drive_id,
      anchor_kind: input.kind,
      latitude: input.latitude,
      longitude: input.longitude,
      recorded_at: input.recorded_at,
      odometer: input.odometer ?? null,
      expected_version: input.expected_version,
      target_request_id: input.request_id,
    });
    if (error)
      return failure(
        'ANCHOR_REJECTED',
        'The test-drive transition could not be saved.',
        requestId,
        409,
      );
    return success({ test_drive: data }, requestId);
  } catch {
    return failure('ANCHOR_FAILED', 'The test-drive anchor could not be saved.', requestId, 500);
  }
});
