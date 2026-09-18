import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../supabase/functions/send-message/index.ts', import.meta.url),
  'utf8',
);
const personalPath = source.slice(
  source.indexOf("if (input.content.type === 'text')"),
  source.indexOf('const { data: conversation }'),
);

describe('personal WhatsApp send latency contract', () => {
  it('uses the atomic prepare RPC as the personal-conversation probe', () => {
    expect(personalPath).toContain("'personal_whatsapp_send_prepare'");
    expect(personalPath).toContain("'personal_whatsapp_send_for_lead'");
    expect(personalPath).toContain("error.message === 'PERSONAL_WHATSAPP_NOT_FOUND'");
    expect(personalPath).not.toContain("from('personal_whatsapp_conversations')");
    expect(personalPath).not.toContain('personalWhatsAppActor');
  });

  it('retains reservation recovery and idempotent duplicate handling', () => {
    expect(personalPath).toContain('prepared?.duplicate');
    expect(personalPath).toContain("personalGateway('POST', '/v1/messages', prepared)");
    expect(personalPath).toContain("target_status: rejectedBeforeSend ? 'FAILED' : 'UNKNOWN'");
  });
});
