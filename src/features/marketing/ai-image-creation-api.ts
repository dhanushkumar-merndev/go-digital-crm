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
