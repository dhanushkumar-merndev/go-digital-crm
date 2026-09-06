import { createClient } from '@/lib/supabase/client';

type EdgeEnvelope<T> = { ok: boolean; data: T | null; error: { code: string } | null };
export type AiImageWorkspace = {
  organization_id: string;
  connections: Array<{ id: string; name: string; provider_key: string; image_model: string }>;
  recent: Array<{
    id: string;
    prompt: string;
    template_key: string;
    style_key: string;
    status: string;
    output_count: number;
    safe_error_code: string | null;
    created_at: string;
    completed_at: string | null;
    outputs: Array<{ object_file_id: string; ordinal: number }>;
  }>;
};

async function invoke<T>(name: string, body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke<EdgeEnvelope<T>>(name, { body });
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'AI_IMAGE_REQUEST_FAILED');
  return data.data;
}
export async function fetchAiImageWorkspace() {
  const client = createClient();
  const [{ data, error }, contextResponse] = await Promise.all([
    client.rpc('get_ai_image_generation_workspace'),
    client.rpc('get_access_context'),
  ]);
  if (error) throw error;
  const context = contextResponse.data as { organization_id?: string } | null;
  if (!context?.organization_id) throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  return {
    ...(data as Omit<AiImageWorkspace, 'organization_id'>),
    organization_id: context.organization_id,
  };
}
export function queueAiImage(input: Record<string, unknown>) {
  return invoke<{ generation_id: string }>('ai-image-generate', input);
}
export function getAiImageUrl(objectFileId: string) {
  return invoke<{ download_url: string }>('ai-image-download', { object_file_id: objectFileId });
}

export type AiImagePromptSettings = {
  system_prompt: string;
  poster_guide: string;
  image_policy: string;
  updated_at: string | null;
};

export const aiImagePromptSettingsKey = ['ai-image-prompt-settings'] as const;

export async function fetchAiImagePromptSettings() {
  const { data, error } = await createClient().rpc('get_ai_image_prompt_settings');
  if (error) throw error;
  return data as AiImagePromptSettings;
}

/**
 * The policy is stored apart from the system prompt because the worker appends
 * it last, after the operator's own prompt, so a prompt cannot talk over it.
 */
export async function saveAiImagePromptSettings(input: {
  systemPrompt: string;
  posterGuide: string;
  imagePolicy: string;
}) {
  const { data, error } = await createClient().rpc('save_ai_image_prompt_settings', {
    target_system_prompt: input.systemPrompt,
    target_poster_guide: input.posterGuide,
    target_image_policy: input.imagePolicy,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return data as AiImagePromptSettings;
}

export type MarketingAsset = {
  id: string;
  name: string;
  source: 'AI_GENERATED' | 'UPLOADED';
  tags: string[];
  object_file_id: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  created_by_name: string;
};

export const marketingAssetLibraryKey = (page: number, search: string, tag: string) =>
  ['marketing-asset-library', page, search, tag] as const;

export async function fetchMarketingAssetLibrary(input: {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  tag: string;
}) {
  const { data, error } = await createClient().rpc('get_marketing_asset_library', {
    target_page: input.page,
    target_page_size: input.pageSize,
    target_search: input.search.trim() || null,
    target_tag: input.tag.trim() || null,
  });
  if (error) throw error;
  return data as { records: MarketingAsset[]; total: number };
}

/** Points the library at an image already stored; it never copies the bytes. */
export async function saveAiImageAsAsset(input: {
  objectFileId: string;
  name: string;
  tags: string[];
}) {
  const { data, error } = await createClient().rpc('save_ai_image_as_asset', {
    target_object_file_id: input.objectFileId,
    target_name: input.name,
    target_tags: input.tags,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return data as { id: string; name: string; replayed: boolean };
}

export async function archiveMarketingAsset(assetId: string) {
  const { error } = await createClient().rpc('archive_marketing_asset', {
    target_asset_id: assetId,
  });
  if (error) throw error;
}
