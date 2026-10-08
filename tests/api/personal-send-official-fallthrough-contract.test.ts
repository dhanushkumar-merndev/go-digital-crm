import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// send-message calls personal_whatsapp_send_for_lead for every text reply and
// only reaches the official WhatsApp path on PERSONAL_WHATSAPP_NOT_FOUND. An
// official thread has no personal row, so the RPC must say so before comparing
// leads, or every lead-linked official reply fails with LEAD_CONTEXT_CHANGED.
const migrations = readdirSync('supabase/migrations')
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(`supabase/migrations/${file}`, 'utf8'));
const latestDefinition = migrations
  .flatMap((sql) =>
    [
      ...sql.matchAll(
        /create or replace function public\.personal_whatsapp_send_for_lead\([\s\S]*?\$function\$;/gi,
      ),
    ].map((match) => match[0]),
  )
  .at(-1);
const sendMessage = readFileSync('supabase/functions/send-message/index.ts', 'utf8');

describe('official WhatsApp replies fall through the personal send check', () => {
  it('reports a non-personal thread before comparing the working lead', () => {
    expect(latestDefinition).toBeDefined();
    const body = latestDefinition!;
    const notFound = body.indexOf("raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'");
    const leadCheck = body.indexOf("raise exception 'LEAD_CONTEXT_CHANGED'");
    expect(notFound).toBeGreaterThan(-1);
    expect(leadCheck).toBeGreaterThan(notFound);
    expect(body).toMatch(/if not found then raise exception 'PERSONAL_WHATSAPP_NOT_FOUND'/);
  });

  it('send-message continues to the official path on that code', () => {
    expect(sendMessage).toContain("error.message === 'PERSONAL_WHATSAPP_NOT_FOUND'");
  });
});
