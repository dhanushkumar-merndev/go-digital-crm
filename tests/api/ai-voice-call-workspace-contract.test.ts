import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220030_ai_voice_call_workspace.sql');
const api = source('src/features/calls/ai-voice-call-workspace-api.ts');
const workspace = source('src/features/calls/ai-voice-call-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('AI voice call workspace contract', () => {
  it('uses bounded server pagination, a verified capability, and normal call data scope', () => {
    expect(migration).toContain(
      'connection_config @> \'{"capabilities":["AI_VOICE_CALLING"]}\'::jsonb',
    );
    expect(migration).toContain("app_private.has_permission(current_organization_id, 'call.view')");
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain('limit target_page_size');
    expect(migration).toContain('offset (target_page - 1) * target_page_size');
    expect(migration).toContain("'recording_available'");
    expect(migration).not.toContain('object_key');
    expect(migration).not.toContain('bucket');
  });

  it('keeps provider calls read-only and uses the approved web query stack', () => {
    expect(api).toContain("rpc('get_ai_voice_call_workspace'");
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain('No verified AI voice provider is connected');
    expect(workspace).not.toContain('apiKey');
    expect(workspace).not.toContain('Create AI Call Campaign');
    expect(route).toContain('<AiVoiceCallWorkspace');
  });
});
