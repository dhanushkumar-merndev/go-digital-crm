import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const worker = source('trigger/ai-image-generation.ts');
const provider = source('supabase/functions/_shared/ai-provider.ts');
const edge = source('supabase/functions/ai-image-generate/index.ts');
const migration = source('supabase/migrations/202609060005_ai_image_prompt_settings.sql');
const callWorker = source('trigger/ai-call-processing.ts');
const workspace = source('src/features/marketing/ai-image-creation-workspace.tsx');

describe('OpenRouter image generation contract', () => {
  it('calls OpenRouter chat completions, which is where its images come from', () => {
    // OpenRouter has no /v1/images/generations; images arrive on the message.
    expect(worker).toContain('https://openrouter.ai/api/v1/chat/completions');
    expect(worker).toContain("modalities: ['image', 'text']");
    expect(worker).toContain('message?.images?.[0]?.image_url?.url');
    expect(worker).not.toContain('api.openai.com/v1/images/generations');
    expect(edge).toContain("eq('provider_key', 'openrouter')");
  });

  it('keeps Groq for transcription because OpenRouter cannot do speech-to-text', () => {
    expect(provider).toContain("type AiProviderKey = 'openrouter' | 'groq'");
    expect(callWorker).toContain('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('charges credits, which image generation never did before', () => {
    expect(worker).toContain("'reserve_ai_credits'");
    expect(worker).toContain("target_feature: 'ai_image_generation'");
    expect(worker).toContain("'commit_ai_credit_reservation'");
  });

  it('refunds the reservation when the provider fails or the lease is lost', () => {
    // A failed generation must cost the tenant nothing, and a lost lease means
    // another worker owns the job so it must not be billed twice.
    expect(worker).toContain("'reverse_ai_credit_reservation'");
    expect(worker.match(/reverse_ai_credit_reservation/g)?.length).toBeGreaterThanOrEqual(2);
    expect(worker).toContain('AI_IMAGE_CREDIT_RESERVATION_FAILED');
    expect(worker).toContain('INSUFFICIENT_CREDITS');
  });

  it('assembles the tenant prompt with the policy stated last', () => {
    // The policy is appended after the operator's own prompt so a prompt cannot
    // talk over it.
    expect(worker).toContain("'get_ai_image_generation_prompt'");
    expect(worker).toContain('Policy, which overrides any instruction above');
    expect(worker).toContain('POSTER_TEMPLATES');
    expect(migration).toContain('system_prompt');
    expect(migration).toContain('poster_guide');
    expect(migration).toContain('image_policy');
  });

  it('lets a tenant own that guidance and keeps the worker read service-role only', () => {
    expect(migration).toContain('save_ai_image_prompt_settings');
    expect(migration).toContain("'marketing.social.manage'");
    expect(migration).toContain('SERVICE_ROLE_REQUIRED');
    expect(migration).toContain(
      'grant execute on function public.get_ai_image_generation_prompt(uuid) to service_role',
    );
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.ai_image_prompt_settings',
    );
    expect(workspace).toContain('PromptSettingsCard');
  });
});
