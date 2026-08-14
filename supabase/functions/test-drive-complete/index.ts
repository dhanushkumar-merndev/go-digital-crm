import { z } from 'npm:zod@4';
import { failure, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const point = z.object({
  sequenceNo: z.int().positive(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  recordedAt: z.iso.datetime(),
});
const schema = z.object({
  test_drive_id: z.uuid(),
  points: z.array(point).max(2000),
  encoded_polyline: z.string().max(100000).optional(),
});
Deno.serve(async (request) => {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Completed route data is invalid.', requestId, 422);
    const { data, error } = await authenticatedClient(request).rpc('finalize_test_drive_route', {
      target_test_drive_id: parsed.data.test_drive_id,
      route_points: parsed.data.points,
      encoded_polyline: parsed.data.encoded_polyline ?? null,
    });
    if (error)
      return failure(
        'ROUTE_FINALIZATION_REJECTED',
        'The completed route could not be saved.',
        requestId,
        409,
      );
    return success({ route_summary_id: data }, requestId);
  } catch {
    return failure(
      'ROUTE_FINALIZATION_FAILED',
      'The completed route could not be saved.',
      requestId,
      500,
    );
  }
});
