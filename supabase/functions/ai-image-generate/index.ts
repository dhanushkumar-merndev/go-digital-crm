import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';

const schema = z.object({
  organization_id: z.uuid(),
  branch_id: z.uuid().nullable().optional(),
  connection_id: z.uuid(),
  prompt: z.string().trim().min(4).max(3000),
  template_key: z.enum([
    'SOCIAL_POST',
    'BANNER',
    'STORY_REEL',
    'WHATSAPP_POST',
    'A4_POSTER',
    'CUSTOM',
  ]),
  object_type: z.enum([
    'CAR_EXTERIOR',
    'CAR_INTERIOR',
    'ACCESSORIES',
    'PEOPLE',
    'BACKGROUND',
    'CUSTOM_OBJECT',
  ]),
  style_key: z.enum(['REALISTIC', 'CINEMATIC', 'PREMIUM', 'MINIMAL', 'SPORTY']),
  aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:5']),
  output_count: z.number().int().min(1).max(4),
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
      return failure('INVALID_PAYLOAD', 'The image generation request is invalid.', requestId, 422);
    const input = parsed.data;
    const client = authenticatedClient(request);
    const { data: auth } = await client.auth.getUser();
    if (!auth.user)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: permitted } = await client.rpc('authorize_action', {
      target_organization_id: input.organization_id,
      target_permission: 'marketing.social.manage',
      target_branch_id: input.branch_id ?? null,
    });
    if (!permitted)
      return failure(
        'PERMISSION_DENIED',
        'You cannot create AI images in this scope.',
        requestId,
        403,
      );

    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,scope_mode,connection_config')
      .eq('id', input.connection_id)
      .eq('organization_id', input.organization_id)
      .eq('provider_key', 'openai')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    const capabilities = connection?.connection_config as {
      capabilities?: string[];
      models?: { image_model?: string };
    } | null;
    if (
      !connection ||
      !capabilities?.capabilities?.includes('IMAGE_GENERATION') ||
      !capabilities.models?.image_model
    )
      return failure(
        'IMAGE_PROVIDER_NOT_CONFIGURED',
        'Choose an active OpenAI image provider connection.',
        requestId,
        409,
      );
    if (input.branch_id && connection.scope_mode !== 'ALL_BRANCHES') {
      const { data: mapping } = await admin
        .from('integration_branch_mappings')
        .select('branch_id')
        .eq('connected_account_id', connection.id)
        .eq('branch_id', input.branch_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (!mapping)
        return failure(
          'CONNECTION_SCOPE_DENIED',
          'That provider connection is not mapped to this branch.',
          requestId,
          403,
        );
    }
    if (!input.branch_id && connection.scope_mode !== 'ALL_BRANCHES')
      return failure(
        'BRANCH_REQUIRED',
        'Choose a branch for this provider connection.',
        requestId,
        422,
      );
    const { data: generation, error } = await admin
      .from('ai_image_generations')
      .insert({
        organization_id: input.organization_id,
        branch_id: input.branch_id ?? null,
        connected_account_id: connection.id,
        prompt: input.prompt,
        template_key: input.template_key,
        object_type: input.object_type,
        style_key: input.style_key,
        aspect_ratio: input.aspect_ratio,
        output_count: input.output_count,
        requested_by: auth.user.id,
      })
      .select('id,status,created_at')
      .single();
    if (error || !generation) throw error ?? new Error('AI_IMAGE_QUEUE_FAILED');
    await admin.from('audit_logs').insert({
      organization_id: input.organization_id,
      actor_id: auth.user.id,
      action: 'ai_image_generation.queued',
      resource_type: 'ai_image_generation',
      resource_id: generation.id,
      branch_id: input.branch_id ?? null,
      request_id: requestId,
      metadata: {
        connection_id: connection.id,
        template_key: input.template_key,
        output_count: input.output_count,
      },
    });
    return success(
      {
        generation_id: generation.id,
        status: generation.status,
        created_at: generation.created_at,
      },
      requestId,
      202,
    );
  } catch {
    return failure(
      'AI_IMAGE_QUEUE_FAILED',
      'The image request could not be queued safely.',
      requestId,
      500,
    );
  }
});
