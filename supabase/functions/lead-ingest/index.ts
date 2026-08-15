import { z } from 'npm:zod@4';
import { failure, preflight, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: z.uuid().optional(),
  source: z.enum([
    'Facebook',
    'Instagram',
    'Google Ads',
    'Website',
    'WhatsApp Business',
    'CarWale',
    'CarDekho',
    'Justdial',
    'IndiaMART',
    'Manual',
    'Other',
  ]),
  source_detail: z.string().trim().max(200).optional(),
  campaign: z.string().trim().max(200).optional(),
  customer_name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(24),
  email: z.email().optional(),
  interested_model: z.string().trim().max(160).optional(),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  try {
    const client = authenticatedClient(request);
    const { data: authData } = await client.auth.getUser();
    if (!authData.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'Lead data is incomplete or invalid.', requestId, 422);
    const input = parsed.data;
    const { data: leadId, error } = await client.rpc('create_lead', {
      target_organization_id: input.organization_id,
      target_branch_id: input.branch_id,
      target_team_id: input.team_id ?? null,
      lead_source: input.source,
      lead_customer_name: input.customer_name,
      lead_phone: input.phone,
      lead_email: input.email ?? null,
      lead_source_detail: input.source_detail ?? null,
      lead_campaign: input.campaign ?? null,
      lead_interested_model: input.interested_model ?? null,
    });
    if (error) {
      if (error.message.includes('PERMISSION_DENIED'))
        return failure(
          'PERMISSION_DENIED',
          'You cannot create leads in this organization.',
          requestId,
          403,
        );
      throw error;
    }
    return success({ lead_id: leadId }, requestId, 201);
  } catch {
    return failure(
      'LEAD_INGEST_FAILED',
      'The lead could not be ingested. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
