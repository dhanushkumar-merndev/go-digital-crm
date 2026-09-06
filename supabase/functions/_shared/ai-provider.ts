// Text, image and analysis now run through OpenRouter, which fronts many model
// families behind one OpenAI-compatible API and one tenant key. Groq stays for
// audio: OpenRouter exposes chat completions and image modalities only, it does
// not proxy speech-to-text, so routing transcription through it would break the
// call pipeline in trigger/ai-call-processing.ts.
export type AiProviderKey = 'openrouter' | 'groq';

export type AiProviderCredential = { api_key: string };

export type AiProviderModels = {
  text_model?: string;
  image_model?: string;
  transcription_model?: string;
  analysis_model?: string;
};

type OpenAiCompatibleModelsResponse = { data?: Array<{ id?: string }> };

function normalizedModelId(model: string) {
  return model.trim();
}

function configuredModelIds(models: AiProviderModels) {
  return [models.text_model, models.image_model, models.transcription_model, models.analysis_model]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizedModelId(value));
}

export function aiProviderModelsEndpoint(providerKey: AiProviderKey) {
  return providerKey === 'openrouter'
    ? 'https://openrouter.ai/api/v1/models'
    : 'https://api.groq.com/openai/v1/models';
}

/**
 * Authenticates a tenant key with the provider and confirms every chosen model
 * is visible to that key. No provider response or secret is returned to callers.
 */
export async function testAiProviderCredential(
  providerKey: AiProviderKey,
  credential: AiProviderCredential,
  models: AiProviderModels,
) {
  const selectedModels = configuredModelIds(models);
  if (!selectedModels.length) throw new Error('AI_MODEL_REQUIRED');

  const response = await fetch(aiProviderModelsEndpoint(providerKey), {
    headers: { authorization: `Bearer ${credential.api_key}` },
  });
  if (!response.ok) throw new Error('AI_PROVIDER_AUTH_FAILED');

  const payload = (await response
    .json()
    .catch(() => null)) as OpenAiCompatibleModelsResponse | null;
  const available = new Set(
    (payload?.data ?? [])
      .map((model) => model.id?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  if (selectedModels.some((model) => !available.has(model)))
    throw new Error('AI_MODEL_UNAVAILABLE');

  return {
    providerAccountLabel: providerKey === 'openrouter' ? 'OpenRouter API key' : 'Groq API key',
  };
}
