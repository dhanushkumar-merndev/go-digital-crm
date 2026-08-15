import { z } from 'npm:zod@4';
import { failure, preflight, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  ledger: z.enum(['AI', 'TRACKING']),
  amount: z.int().positive(),
  feature: z.string().min(1).max(100),
  idempotency_key: z.string().min(8).max(200),
  reason: z.string().min(3).max(300),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const client = authenticatedClient(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Credit request is invalid.', requestId, 422);
    const input = parsed.data;
    const { data, error } = await client.rpc('consume_credits', {
      target_organization_id: input.organization_id,
      target_ledger: input.ledger,
      requested_amount: input.amount,
      target_feature: input.feature,
      idempotency_key: input.idempotency_key,
      consumption_reason: input.reason,
    });
    if (error?.message.includes('INSUFFICIENT_CREDITS'))
      return failure(
        'INSUFFICIENT_CREDITS',
        'There are not enough credits for this action.',
        requestId,
        409,
      );
    if (error)
      return failure('CREDIT_CONSUMPTION_FAILED', 'Credits could not be reserved.', requestId, 400);
    return success(data?.[0] ?? null, requestId);
  } catch {
    return failure('CREDIT_CONSUMPTION_FAILED', 'Credits could not be reserved.', requestId, 500);
  }
});
