import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220025_ai_image_generation_workflow.sql');
const queueFunction = source('supabase/functions/ai-image-generate/index.ts');
const downloadFunction = source('supabase/functions/ai-image-download/index.ts');
const worker = source('trigger/ai-image-generation.ts');
const dispatcher = source('trigger/minute-dispatch.ts');
const api = source('src/features/marketing/ai-image-creation-api.ts');
const workspace = source('src/features/marketing/ai-image-creation-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('AI image generation workflow contract', () => {
  it('persists private, tenant-scoped generation jobs and outputs through controlled RPCs', () => {
    expect(migration).toContain('create table public.ai_image_generations');
    expect(migration).toContain('create table public.ai_image_generation_outputs');
    expect(migration).toContain('get_ai_image_generation_workspace');
    expect(migration).toContain('claim_ai_image_generations');
    expect(migration).toContain('complete_ai_image_generation');
    expect(migration).toContain('retry_ai_image_generation');
    expect(migration).toContain('enable row level security');
  });

  it('queues only authorized image-capable provider connections and does not expose credentials', () => {
    expect(queueFunction).toContain("target_permission: 'marketing.social.manage'");
    expect(queueFunction).toContain("'IMAGE_GENERATION'");
    expect(queueFunction).toContain('.insert({\n        organization_id: input.organization_id');
    expect(queueFunction).toContain("action: 'ai_image_generation.queued'");
    expect(queueFunction).not.toContain('api_key');
  });

  it('runs external generation asynchronously and stores the completed outputs in private object storage', () => {
    // Scheduling moved into trigger/minute-dispatch.ts: six tasks shared this
    // cron and the project allows only 10 schedules.
    expect(worker).toContain('export async function runAiImageGeneration(');
    expect(dispatcher).toContain('runAiImageGeneration');
    expect(dispatcher).toContain('schedules.task');
    expect(worker).toContain('openrouter.ai/api/v1/chat/completions');
    expect(worker).toContain('claim_ai_image_generations');
    expect(worker).toContain('PutObjectCommand');
    expect(worker).toContain('complete_ai_image_generation');
    expect(worker).toContain('retry_ai_image_generation');
  });

  it('returns only short-lived authorized preview URLs to the browser', () => {
    expect(downloadFunction).toContain("target_permission: 'marketing.social.manage'");
    expect(downloadFunction).toContain('getSignedUrl');
    expect(downloadFunction).toContain('expiresIn: 300');
    expect(api).toContain("'ai-image-generate'");
    expect(api).toContain("'ai-image-download'");
  });

  it('provides a usable marketing workspace with active generation polling and a routed page', () => {
    expect(workspace).toContain('refetchInterval: 8_000');
    expect(workspace).toContain('Generate ${count} image');
    expect(workspace).toContain('Preview & results');
    expect(workspace).toContain('getAiImageUrl');
    expect(workspace).toContain("title: 'Image generation queued'");
    expect(workspace).toContain("title: 'Image was not queued'");
    expect(workspace).toContain("title: 'Preview is unavailable'");
    expect(route).toContain("slug[0] === 'ai-content-image'");
    expect(route).toContain('AiImageCreationWorkspace');
  });
});
