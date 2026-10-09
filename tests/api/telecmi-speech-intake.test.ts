import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractTelecmiSpeech,
  unrecognisedPayloadFields,
} from '../../supabase/functions/_shared/telecmi-speech';

const cdr = {
  appid: 33338826,
  type: 'cdr',
  leg: 'b',
  call_id: 'c-1',
  cmiuuid: 'u-1',
  status: 'answered',
  record: true,
  filename: 'x_33338826.mp3',
};

describe('TeleCMI Speech IVR extraction', () => {
  it('returns null for a plain CDR, so nothing is saved', () => {
    expect(extractTelecmiSpeech(cdr)).toBeNull();
  });

  it('reads a flat transcript and summary on the CDR', () => {
    expect(
      extractTelecmiSpeech({ ...cdr, transcript: '  Hello sir  ', summary: 'Wants Elevate.' }),
    ).toEqual({ transcript: 'Hello sir', turns: [], summary: 'Wants Elevate.', language: null });
  });

  it('maps segment arrays to agent and customer turns', () => {
    const speech = extractTelecmiSpeech({
      ...cdr,
      transcript: [
        { speaker: 'agent', text: 'Good morning' },
        { channel: 1, text: 'Price of City?' },
        { leg: 'b', text: 'And mileage' },
        { role: 'bot', text: 'Noted' },
        { speaker: 'agent', text: '   ' },
      ],
    });
    expect(speech?.turns).toEqual([
      { speaker: 'AGENT', text: 'Good morning' },
      { speaker: 'CUSTOMER', text: 'Price of City?' },
      { speaker: 'CUSTOMER', text: 'And mileage' },
      { speaker: 'UNKNOWN', text: 'Noted' },
    ]);
  });

  it('accepts JSON-string values and a nested speech_ivr container', () => {
    const speech = extractTelecmiSpeech({
      ...cdr,
      speech_ivr: JSON.stringify({
        text: 'Full call text',
        segments: [{ speaker: 'customer', text: 'Hi' }],
        summary: { text: 'Customer greeted.' },
        language: 'hi-IN',
      }),
    });
    expect(speech).toEqual({
      transcript: 'Full call text',
      turns: [{ speaker: 'CUSTOMER', text: 'Hi' }],
      summary: 'Customer greeted.',
      language: 'hi-IN',
    });
  });

  it('does not treat a generic top-level text field as a transcript', () => {
    expect(extractTelecmiSpeech({ ...cdr, text: 'SMS body', content: 'x' })).toBeNull();
  });

  it('bounds transcript and summary sizes', () => {
    const speech = extractTelecmiSpeech({
      ...cdr,
      transcription: 'a'.repeat(1_200_000),
      call_summary: 'b'.repeat(30_000),
    });
    expect(speech?.transcript).toHaveLength(1_000_000);
    expect(speech?.summary).toHaveLength(20_000);
  });
});

describe('unrecognised TeleCMI fields', () => {
  const known = new Set(Object.keys(cdr));

  it('reports names, types and sizes but never values', () => {
    const fields = unrecognisedPayloadFields(
      { ...cdr, speech_ivr: { transcript: 'Customer said secret thing', confidence: 0.9 } },
      known,
    );
    expect(fields).toEqual([
      { key: 'speech_ivr', type: 'object', size: 2 },
      { key: 'speech_ivr.transcript', type: 'string', size: 26 },
      { key: 'speech_ivr.confidence', type: 'number', size: null },
    ]);
    expect(JSON.stringify(fields)).not.toContain('secret');
  });

  it('caps the list and sanitises key names', () => {
    const payload = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}<script>`, i]));
    const fields = unrecognisedPayloadFields(payload, known);
    expect(fields).toHaveLength(60);
    expect(fields[0].key).toBe('f0_script_');
  });
});

describe('TeleCMI webhook Speech IVR wiring', () => {
  const webhook = readFileSync('supabase/functions/provider-webhook-telecmi/index.ts', 'utf8');
  const migration = readFileSync(
    'supabase/migrations/202610091201_provider_call_intelligence.sql',
    'utf8',
  );

  it('saves speech against the mapped CRM call as a zero-credit TELECMI source', () => {
    expect(webhook).toContain("admin.rpc('save_provider_call_intelligence'");
    expect(webhook).toContain("target_source: 'TELECMI'");
    expect(webhook).toContain('if (speech && appliedCallId)');
    expect(webhook).not.toContain('reserve_ai_credits');
  });

  it('keeps only names and sizes of unknown fields on the stored receipt', () => {
    expect(webhook).toContain('extra_fields: extraFields');
    expect(webhook).toContain('transcript_chars: speech.transcript?.length ?? 0');
  });

  it('accepts a CDR redelivered with speech instead of refusing it as a conflict', () => {
    expect(webhook).toContain(
      'if (!constantTimeEqual(existing.payload_hash, payloadHash) && !speech) return response(409);',
    );
  });

  it('stores one provider transcript per call, service role only', () => {
    expect(migration).toContain("check (source in ('AI', 'TELECMI', 'AI_AGENT'))");
    expect(migration).toContain('on public.call_transcripts (organization_id, call_id, source)');
    expect(migration).toContain(
      "on conflict (organization_id, call_id, source) where source in ('TELECMI', 'AI_AGENT')",
    );
    expect(migration).toContain("message = 'SERVICE_ROLE_REQUIRED'");
    expect(migration).toContain("'call.provider_intelligence_saved'");
  });
});
