import { describe, expect, it, vi } from 'vitest';
import {
  goodbyeActions,
  pcmoPrompt,
  piopiyCallEvent,
  PiopiyError,
  piopiyNumber,
  pressedKey,
  questionAction,
  startPiopiyAiCall,
  startPiopiyPcmoCall,
} from '../../supabase/functions/_shared/piopiy';

const credential = {
  token: 'server-only-token',
  app_id: 'app-1',
  caller_id: '918069000000',
  webhook_secret: 'secret',
};
const voice = { language: 'en-IN', voice_id: 'female', speed: 1 };
const node = {
  title: 'Interested',
  prompt: { text: 'Press 1 for yes.' },
  timeout_sec: 6,
  retries: 1,
  on_no_input: 'END',
  options: [{ key: '1', label: 'Yes', next: 'END' }],
};

function call(fetcher: typeof fetch) {
  return startPiopiyPcmoCall(
    credential,
    {
      toNumber: '+91 70100 06438',
      pipeline: [questionAction(node, pcmoPrompt(node.prompt, voice, null), 'https://x/answer')],
      ringTimeoutSec: 30,
      maxDurationSec: 300,
      variables: { crm_call_id: 'call-1' },
    },
    fetcher,
  );
}

describe('PIOPIY auto-call adapter', () => {
  it('normalizes Indian mobiles to the digits PIOPIY expects', () => {
    expect(piopiyNumber('+91 70100 06438')).toBe('917010006438');
    expect(piopiyNumber('07010006438')).toBe('917010006438');
    expect(piopiyNumber('7010006438')).toBe('917010006438');
    expect(() => piopiyNumber('12')).toThrow(PiopiyError);
  });

  it('speaks text with the connection voice and prefers an uploaded recording', () => {
    expect(pcmoPrompt({ text: 'Hi' }, voice, null, 'Hello.')).toEqual({
      type: 'say',
      say: 'Hello. Hi',
      language: 'en-IN',
      voice_id: 'female',
      speed: 1,
    });
    expect(pcmoPrompt({ text: 'Hi', language: 'ta-IN' }, voice, null).type).toBe('say');
    expect(pcmoPrompt({ text: 'Hi' }, voice, 'https://tigris/signed')).toEqual({
      type: 'file',
      file_name: 'https://tigris/signed',
    });
  });

  it('asks for one key per question and handles repeats itself', () => {
    const action = questionAction(node, pcmoPrompt(node.prompt, voice, null), 'https://x/a');
    expect(action).toMatchObject({
      action: 'play_get_input',
      input: ['dtmf'],
      dtmf: { max_digits: 1, first_digit_timeout: 6 },
      retries: { max: 0 },
      on_result: { type: 'url', url: 'https://x/a' },
    });
    expect(goodbyeActions({ type: 'file', file_name: 'https://f' }, 'https://h')).toEqual([
      { action: 'play', file_name: 'https://f' },
      { action: 'hangup' },
    ]);
  });

  it('posts a PCMO call with a Bearer token and returns the provider call id', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { call_id: 'pio-1' } }));
    await expect(call(fetcher)).resolves.toBe('pio-1');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://rest.piopiy.com/v3/voice/pcmo/call');
    expect(init.headers.authorization).toBe('Bearer server-only-token');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      caller_id: '918069000000',
      to_number: '917010006438',
      app_id: 'app-1',
      options: { record: true, ring_timeout_sec: 30, max_duration_sec: 300 },
    });
    expect(JSON.stringify(body)).not.toContain('webhook_secret');
  });

  it('classifies auth failure, rate limit, server error and malformed responses', async () => {
    const failing = (status: number) => vi.fn().mockResolvedValue(new Response('{}', { status }));
    await expect(call(failing(401))).rejects.toMatchObject({
      code: 'PIOPIY_AUTH_FAILED',
      retryable: false,
      pauseDialer: true,
    });
    await expect(call(failing(429))).rejects.toMatchObject({
      code: 'PIOPIY_RATE_LIMITED',
      retryable: true,
    });
    await expect(call(failing(503))).rejects.toMatchObject({
      code: 'PIOPIY_UNAVAILABLE',
      retryable: true,
    });
    await expect(
      call(vi.fn().mockResolvedValue(Response.json({ ok: true }))),
    ).rejects.toMatchObject({ code: 'PIOPIY_RESPONSE_MALFORMED' });
    await expect(call(vi.fn().mockRejectedValue(new TypeError('network')))).rejects.toMatchObject({
      code: 'PIOPIY_UNREACHABLE',
      retryable: true,
    });
  });

  it('reads the pressed key from any of the shapes PIOPIY may send', () => {
    expect(pressedKey({ digits: '1' })).toBe('1');
    expect(pressedKey({ dtmf: 2 })).toBe('2');
    expect(pressedKey({ data: { input: '3#' } })).toBe('3');
    expect(pressedKey({ result: { value: '*' } })).toBe('*');
    expect(pressedKey({ call: 'x' })).toBeNull();
  });

  it('recognizes end-of-call events and keeps only https recording URLs', () => {
    expect(
      piopiyCallEvent({
        call_id: 'pio-1',
        status: 'completed',
        duration: '42',
        recording_url: 'https://rec/1.mp3',
      }),
    ).toEqual({
      callId: 'pio-1',
      status: 'COMPLETED',
      terminal: true,
      durationSeconds: 42,
      recordingUrl: 'https://rec/1.mp3',
      recordingRef: 'https://rec/1.mp3',
    });
    expect(piopiyCallEvent({ call_id: 'pio-1', status: 'ringing' }).terminal).toBe(false);
    expect(piopiyCallEvent({ data: { uuid: 'pio-2', state: 'No Answer' } })).toMatchObject({
      callId: 'pio-2',
      status: 'NO_ANSWER',
      terminal: true,
    });
    expect(
      piopiyCallEvent({ call_id: 'p', status: 'completed', recording: 'http://insecure' })
        .recordingUrl,
    ).toBeNull();
  });

  describe('AI agent calls', () => {
    const variables = {
      crm_call_id: '87bfa54c-64cb-4ec7-b7d4-1c5f9be77744',
      context_token: 'a'.repeat(64),
    };
    function aiCall(fetcher: typeof fetch, agentId = 'bdd32bcb-767c-40a5-be4a-5f45eeb348a6') {
      return startPiopiyAiCall(
        credential,
        { agentId, toNumber: '7010006438', ringTimeoutSec: 30, maxDurationSec: 300, variables },
        fetcher,
      );
    }

    it('posts to the AI call endpoint with the agent id and only the call reference', async () => {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ call_id: 'pio-ai-1' }));
      await expect(aiCall(fetcher)).resolves.toBe('pio-ai-1');
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe('https://rest.piopiy.com/v3/voice/ai/call');
      expect(init.headers.authorization).toBe('Bearer server-only-token');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        caller_id: '918069000000',
        to_number: '917010006438',
        agent_id: 'bdd32bcb-767c-40a5-be4a-5f45eeb348a6',
        options: { max_duration_sec: 300, ring_timeout_sec: 30, record: true },
        variables,
      });
      // Customer details never travel through TeleCMI's metadata.
      expect(Object.keys(body.variables)).toEqual(['crm_call_id', 'context_token']);
    });

    it('pauses the dialer when no AI agent is configured, without calling PIOPIY', async () => {
      const fetcher = vi.fn();
      await expect(aiCall(fetcher, '')).rejects.toMatchObject({
        code: 'AI_AGENT_NOT_CONFIGURED',
        pauseDialer: true,
      });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('classifies provider failures like keypad calls', async () => {
      const failing = (status: number) => vi.fn().mockResolvedValue(new Response('{}', { status }));
      await expect(aiCall(failing(401))).rejects.toMatchObject({
        code: 'PIOPIY_AUTH_FAILED',
        pauseDialer: true,
      });
      await expect(aiCall(failing(402))).rejects.toMatchObject({
        code: 'PIOPIY_BALANCE_LOW',
        pauseDialer: true,
      });
      await expect(aiCall(failing(429))).rejects.toMatchObject({
        code: 'PIOPIY_RATE_LIMITED',
        retryable: true,
      });
      await expect(aiCall(failing(500))).rejects.toMatchObject({ code: 'PIOPIY_UNAVAILABLE' });
      await expect(
        aiCall(vi.fn().mockResolvedValue(Response.json({ accepted: true }))),
      ).rejects.toMatchObject({ code: 'PIOPIY_RESPONSE_MALFORMED' });
    });
  });
});
