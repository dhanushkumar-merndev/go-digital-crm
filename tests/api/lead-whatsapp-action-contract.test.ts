import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const detail = readFileSync('src/features/leads/lead-detail-workspace.tsx', 'utf8');
const inbox = readFileSync('src/features/inbox/inbox-workspace.tsx', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202610030001_lead_whatsapp_actions.sql',
  'utf8',
);

describe('lead WhatsApp channel action', () => {
  it('offers CRM personal, official API, and handset choices from the lead row', () => {
    expect(workspace).toContain('My WhatsApp');
    expect(workspace).toContain('WhatsApp API');
    expect(workspace).toContain('WhatsApp on my phone');
    expect(workspace).toContain("onProviderWhatsApp(row.original, 'WHATSAPP_PERSONAL')");
    expect(workspace).toContain("onProviderWhatsApp(row.original, 'WHATSAPP_BUSINESS')");
  });

  it('opens the chosen thread in the lead-scoped inbox', () => {
    expect(workspace).toContain("tab: 'messages'");
    expect(workspace).toContain('conversation: conversation.conversation_id');
    expect(detail).toContain('initialChannel={initialMessageChannel}');
    expect(detail).toContain('initialConversationId={requestedConversation}');
    expect(inbox).toContain('useState(initialChannel)');
    expect(inbox).toContain('useState<string | null>(initialConversationId)');
  });

  it('resolves provider connections server-side under permission and scope checks', () => {
    expect(migration).toContain("app_private.has_permission(organization, 'message.send')");
    expect(migration).toContain('app_private.can_access_lead(target_lead_id)');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain("provider_key = 'whatsapp_cloud'");
    expect(migration).toContain('owner_user_id = auth.uid()');
    expect(migration).toContain("'conversation.opened_from_lead'");
    expect(migration).toContain(
      'grant execute on function public.open_lead_whatsapp_conversation(uuid, text) to authenticated',
    );
  });
});
