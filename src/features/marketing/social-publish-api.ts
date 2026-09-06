import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const resultSchema = z.object({
  id: z.uuid(),
  status: z.literal('PUBLISH_REQUESTED'),
  replayed: z.boolean(),
});

/**
 * Moves a reviewed draft into the publish queue. The Meta connection is pinned
 * here rather than resolved at send time, so the account a person chose is the
 * account that posts.
 */
export async function requestSocialPostPublish(input: {
  postId: string;
  connectedAccountId: string;
  assetId: string | null;
  scheduledFor: string | null;
}) {
  const { data, error } = await createClient().rpc('request_social_post_publish', {
    target_post_id: input.postId,
    target_connected_account_id: input.connectedAccountId,
    target_asset_id: input.assetId,
    target_scheduled_for: input.scheduledFor,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return resultSchema.parse(data);
}

export function getSocialPublishErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('SOCIAL_IMAGE_REQUIRED'))
    return 'Instagram will not accept a caption without an image. Attach an asset first.';
  if (message.includes('SOCIAL_PLATFORM_NOT_PUBLISHABLE'))
    return 'Only Facebook and Instagram can be published from here.';
  if (message.includes('SOCIAL_CONNECTION_NOT_AVAILABLE'))
    return 'Connect a Meta account before publishing.';
  if (message.includes('SOCIAL_ASSET_NOT_FOUND'))
    return 'That asset is no longer in the library. Pick another.';
  if (message.includes('SOCIAL_POST_NOT_PUBLISHABLE'))
    return 'This post has already been published or cannot be published in its current state.';
  if (message.includes('SOCIAL_POST_SCOPE_DENIED'))
    return 'This post belongs to a branch outside your scope.';
  if (message.includes('MARKETING_SOCIAL_PERMISSION_REQUIRED'))
    return 'You are not allowed to publish social posts.';
  return 'The post could not be queued for publishing. Try again in a moment.';
}
