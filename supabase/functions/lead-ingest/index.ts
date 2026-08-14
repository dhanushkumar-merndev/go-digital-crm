import { z } from 'npm:zod@4';
import { failure, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: z.uuid().optional(),
  connection_id: z.uuid().optional(),
  external_lead_id: z.string().trim().min(1).max(250).optional(),
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
  raw_payload: z.unknown().optional(),
});

Deno.serve(async (request) => {
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
    const normalizedPhone = input.phone.replace(/[^\d+]/g, '');
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: input.organization_id,
      target_permission: 'lead.create',
      target_branch_id: input.branch_id,
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot create leads in this organization.',
        requestId,
        403,
      );
    const admin = serviceClient();
    const { data, error } = await admin
      .from('leads')
      .upsert(
        { ...input, normalized_phone: normalizedPhone, raw_payload: input.raw_payload ?? null },
        { onConflict: 'organization_id,connection_id,external_lead_id', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return success({ lead_id: data?.id ?? null, duplicate: !data }, requestId, data ? 201 : 200);
  } catch {
    return failure(
      'LEAD_INGEST_FAILED',
      'The lead could not be ingested. Use the reference ID when contacting support.',
      requestId,
      500,
    );
  }
});
