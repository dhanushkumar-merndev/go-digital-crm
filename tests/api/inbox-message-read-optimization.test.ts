import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../supabase/migrations/202609160012_optimize_inbox_message_reads.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('inbox message read optimization', () => {
  it('authorizes the thread once and reads only messages bound to it', () => {
    expect(migration).toContain('from app_private.accessible_inbox_threads');
    expect(migration).toContain('m.organization_id=thread.organization_id');
    expect(migration).toContain('m.conversation_id=thread.id');
  });
  it('removes the expensive per-message access view from hot paths', () => {
    expect(migration).not.toContain('app_private.accessible_inbox_messages');
    expect(migration).toContain('public.conversation_messages');
    expect(migration).toContain('public.personal_whatsapp_messages');
  });
  it('retains pagination, context filters, soft deletion and grants', () => {
    expect(migration).toContain('target_page_size+1');
    expect(migration).toContain('target_lead_id');
    expect(migration).toContain('m.deleted_at is null');
    expect(migration).toContain('grant execute on function public.get_context_inbox_page');
  });
});
