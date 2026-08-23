export type AiProviderKey = 'openai' | 'gemini' | 'groq';

export type AiProviderCredential = { api_key: string };

export type AiProviderModels = {
  text_model?: string;
  image_model?: string;
  transcription_model?: string;
  analysis_model?: string;
};

type OpenAiModelsResponse = { data?: Array<{ id?: string }> };
type GeminiModelsResponse = { models?: Array<{ name?: string }> };

function normalizedModelId(providerKey: AiProviderKey, model: string) {
  const trimmed = model.trim();
  return providerKey === 'gemini' ? trimmed.replace(/^models\//, '') : trimmed;
}

function configuredModelIds(providerKey: AiProviderKey, models: AiProviderModels) {
  return [models.text_model, models.image_model, models.transcription_model, models.analysis_model]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizedModelId(providerKey, value));
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
  const selectedModels = configuredModelIds(providerKey, models);
  if (!selectedModels.length) throw new Error('AI_MODEL_REQUIRED');

  const endpoint =
    providerKey === 'openai'
      ? 'https://api.openai.com/v1/models'
      : providerKey === 'groq'
        ? 'https://api.groq.com/openai/v1/models'
        : 'https://generativelanguage.googleapis.com/v1beta/models';
  const response = await fetch(endpoint, {
    headers:
      providerKey === 'openai' || providerKey === 'groq'
        ? { authorization: `Bearer ${credential.api_key}` }
        : { 'x-goog-api-key': credential.api_key },
  });
  if (!response.ok) throw new Error('AI_PROVIDER_AUTH_FAILED');

  const payload = (await response.json().catch(() => null)) as
    OpenAiModelsResponse | GeminiModelsResponse | null;
  const available = new Set(
    providerKey === 'openai' || providerKey === 'groq'
      ? ((payload as OpenAiModelsResponse | null)?.data ?? [])
          .map((model) => model.id?.trim())
          .filter((id): id is string => Boolean(id))
      : ((payload as GeminiModelsResponse | null)?.models ?? [])
          .map((model) => model.name?.replace(/^models\//, '').trim())
          .filter((id): id is string => Boolean(id)),
  );
  if (selectedModels.some((model) => !available.has(model)))
    throw new Error('AI_MODEL_UNAVAILABLE');

  return {
    providerAccountLabel:
      providerKey === 'openai'
        ? 'OpenAI API key'
        : providerKey === 'groq'
          ? 'Groq API key'
          : 'Gemini API key',
  };
}
