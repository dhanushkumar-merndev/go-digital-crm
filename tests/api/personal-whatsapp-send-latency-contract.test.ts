import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../supabase/functions/send-message/index.ts', import.meta.url),
  'utf8',
);
// The prepare RPC starts alongside the user check and conversation read, so the
// personal path runs from that parallel start to the official-path fallthrough.
const personalPath = source.slice(
  source.indexOf('const personalPrepare'),
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

  it('reads the personal probe and the conversation in one parallel step', () => {
    expect(personalPath).toContain('await Promise.all([');
    expect(personalPath).toContain('client.auth.getUser(),');
  });

  it('retains reservation recovery and idempotent duplicate handling', () => {
    expect(personalPath).toContain('prepared?.duplicate');
    expect(personalPath).toContain("personalGateway('POST', '/v1/messages', prepared)");
    expect(personalPath).toContain("target_status: rejectedBeforeSend ? 'FAILED' : 'UNKNOWN'");
  });
});
