import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const connectFunction = source('supabase/functions/ai-provider-connect/index.ts');
const testFunction = source('supabase/functions/ai-provider-test/index.ts');
const provider = source('supabase/functions/_shared/ai-provider.ts');
const api = source('src/features/integrations/integration-workspace-api.ts');
const workspace = source('src/features/integrations/integration-workspace.tsx');
const contracts = source('src/lib/providers/contracts.ts');

describe('tenant AI provider connection contract', () => {
  it('routes text, image and analysis through OpenRouter and keeps Groq for audio', () => {
    // OpenRouter exposes chat completions and image modalities only; it does not
    // proxy speech-to-text, so transcription stays on Groq.
    expect(connectFunction).toContain("z.enum(['openrouter', 'groq'])");
    expect(provider).toContain("type AiProviderKey = 'openrouter' | 'groq'");
    expect(workspace).toContain(
      "{ value: 'openrouter', label: 'OpenRouter text, image & analysis models' }",
    );
    expect(workspace).toContain("{ value: 'groq', label: 'Groq transcription & AI analysis' }");
  });

  it('requires authorized tenant integration scope, model compatibility, and a server-side credential test', () => {
    expect(connectFunction).toContain("target_permission: 'integration.manage'");
    expect(connectFunction).toContain('authorize_integration_scope');
    expect(connectFunction).toContain('authorize_integration_connection_action');
    expect(connectFunction).toContain('testAiProviderCredential(');
    expect(provider).toContain('https://openrouter.ai/api/v1/models');
    expect(provider).toContain('https://api.groq.com/openai/v1/models');
    expect(provider).toContain('AI_MODEL_UNAVAILABLE');
  });

  it('keeps keys encrypted and never puts them in connection configuration or response data', () => {
    expect(connectFunction).toContain(
      'encrypted_payload: await encryptJson({ api_key: input.api_key })',
    );
    expect(connectFunction).toContain('connection_config: connectionConfig');
    expect(connectFunction).toContain("'TEXT_GENERATION'");
    expect(connectFunction).toContain("'IMAGE_GENERATION'");
    expect(connectFunction).not.toContain('api_key: input.api_key,\n        connection_config');
    expect(connectFunction).toContain(
      "action: input.connection_id ? 'ai_provider.credential_replaced' : 'ai_provider.connected'",
    );
    expect(testFunction).toContain('decryptJson<AiProviderCredential>');
    expect(testFunction).not.toContain('api_key: credential.api_key');
  });

  it('offers separate text and image models and exposes provider-neutral execution contracts', () => {
    expect(workspace).toContain(
      'Text, image, transcription, and call analysis use separate models',
    );
    expect(workspace).toContain('name="textModel"');
    expect(workspace).toContain('name="imageModel"');
    expect(api).toContain("'ai-provider-connect'");
    expect(api).toContain("'ai-provider-test'");
    expect(contracts).toContain('generateText(');
    expect(contracts).toContain('generateImage(');
  });
});
