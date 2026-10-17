import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiAgentRpcFailure,
  readSignedAiAgentBody,
} from '../../supabase/functions/_shared/ai-agent';

const secret = 'x'.repeat(40);

// Mirrors services/voice-agent/voice_agent/crm.py signed_request.
function signed(body: string, timestamp = Math.floor(Date.now() / 1000), key = secret) {
  const digest = createHmac('sha256', key).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return new Request('https://edge.test/provider-ai-agent-result', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ai-agent-timestamp': String(timestamp),
      'x-ai-agent-signature': `sha256=${digest}`,
    },
    body,
  });
}

describe('voice-agent request signing', () => {
  beforeEach(() => {
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => (name === 'AI_AGENT_SERVICE_SECRET' ? secret : undefined) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a body signed by the voice agent, including non-ASCII text', async () => {
    const body = JSON.stringify({ call_id: 'c', summary: 'ಗ್ರಾಹಕರು ಕ್ರೆಟಾ ಬಯಸುತ್ತಾರೆ' });
    await expect(readSignedAiAgentBody(signed(body))).resolves.toBe(body);
  });

  it('rejects a wrong secret, a tampered body and a stale timestamp', async () => {
    const body = JSON.stringify({ call_id: 'c' });
    await expect(
      readSignedAiAgentBody(signed(body, undefined, 'y'.repeat(40))),
    ).resolves.toBeNull();
    const tampered = signed(body);
    const forged = new Request(tampered.url, {
      method: 'POST',
      headers: tampered.headers,
      body: JSON.stringify({ call_id: 'other' }),
    });
    await expect(readSignedAiAgentBody(forged)).resolves.toBeNull();
    const stale = Math.floor(Date.now() / 1000) - 600;
    await expect(readSignedAiAgentBody(signed(body, stale))).resolves.toBeNull();
  });

  it('refuses everything when the service secret is missing or short', async () => {
    vi.stubGlobal('Deno', { env: { get: () => 'short' } });
    await expect(readSignedAiAgentBody(signed('{}'))).resolves.toBeNull();
  });

  it('maps database errors to stable codes without leaking details', async () => {
    expect(aiAgentRpcFailure({ message: 'AI_CALL_TOKEN_INVALID' }).status).toBe(403);
    expect(aiAgentRpcFailure({ message: 'AI_CALL_CLOSED' }).status).toBe(409);
    expect(aiAgentRpcFailure({ message: 'AUTO_CALL_NOT_FOUND' }).status).toBe(404);
    const invalid = aiAgentRpcFailure({ code: '22023', message: 'something internal' });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({ code: 'AI_CALL_RESULT_INVALID' });
    expect(aiAgentRpcFailure({ message: 'boom' }).status).toBe(500);
  });
});
