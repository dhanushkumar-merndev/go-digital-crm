import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const branchSchema = z.object({ id: z.uuid(), name: z.string() });
const optionsSchema = z.object({
  can_use_organization_scope: z.boolean(),
  branches: z.array(branchSchema),
});
const resultSchema = z.object({
  id: z.uuid(),
  status: z.literal('DRAFT'),
  platform: z.enum(['FACEBOOK', 'INSTAGRAM', 'GOOGLE_BUSINESS_PROFILE', 'OTHER']),
  branch_id: z.uuid().nullable(),
  replayed: z.boolean(),
});

export type SocialPostDraftOptions = z.infer<typeof optionsSchema>;
export type SocialPostPlatform = z.infer<typeof resultSchema.shape.platform>;

export async function fetchSocialPostDraftOptions(signal?: AbortSignal) {
  const request = createClient().rpc('get_social_post_draft_options');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return optionsSchema.parse(data);
}

export async function createSocialPostDraft(input: {
  platform: SocialPostPlatform;
  content: string;
  branchId: string | null;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_social_post_draft', {
    target_platform: input.platform,
    target_content: input.content,
    target_branch_id: input.branchId,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return resultSchema.parse(data);
}
