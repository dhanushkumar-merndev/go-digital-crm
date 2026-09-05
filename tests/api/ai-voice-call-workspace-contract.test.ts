import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609040002_telecmi_ai_voice_completion.sql');
const workspaceMigration = migration.slice(
  migration.indexOf('create or replace function public.get_ai_voice_call_workspace('),
  migration.indexOf('create or replace function public.get_call_speaker_transcript('),
);
const api = source('src/features/calls/ai-voice-call-workspace-api.ts');
const workspace = source('src/features/calls/ai-voice-call-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('AI voice call workspace contract', () => {
  it('uses call-mode identity, bounded pagination, and normal call data scope', () => {
    expect(workspaceMigration).toContain("call_row.call_source = 'PROVIDER'");
    expect(workspaceMigration).toContain("call_row.call_mode = 'AI_AGENT'");
    expect(workspaceMigration).toContain('public.ai_voice_agents');
    expect(workspaceMigration).not.toContain(
      'connection_config @> \'{"capabilities":["AI_VOICE_CALLING"]}\'::jsonb',
    );
    expect(workspaceMigration).toContain(
      "app_private.has_permission(current_organization_id, 'call.view')",
    );
    expect(workspaceMigration).toContain('app_private.can_access_record(');
    expect(workspaceMigration).toContain('limit target_page_size');
    expect(workspaceMigration).toContain('offset (target_page - 1) * target_page_size');
    expect(workspaceMigration).toContain("'recording_available'");
    expect(workspaceMigration).not.toContain('object_key');
    expect(workspaceMigration).not.toContain('bucket');
  });

  it('returns branch and assigned-telecaller context without leaking storage internals', () => {
    expect(workspaceMigration).toContain("'branch_name', page_row.branch_name");
    expect(workspaceMigration).toContain("'telecaller_name', page_row.telecaller_name");
    expect(workspaceMigration).toContain("upper(status) in ('PENDING', 'RINGING', 'IN_PROGRESS')");
    expect(api).toContain('branch_name: z.string()');
    expect(api).toContain('telecaller_name: z.string()');
  });

  it('keeps automated calls read-only and uses the approved web query stack', () => {
    expect(api).toContain("rpc('get_ai_voice_call_workspace'");
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain('AI fallback agent');
    expect(workspace).toContain('record.branch_name');
    expect(workspace).toContain('record.telecaller_name');
    expect(workspace).not.toContain('apiKey');
    expect(workspace).not.toContain('Create AI Call Campaign');
    expect(route).toContain('<AiVoiceCallWorkspace');
  });
});
