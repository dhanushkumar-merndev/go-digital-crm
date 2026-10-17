import { constantTimeEqual, hmacSha256Hex } from './crypto.ts';

// Shared by the two endpoints our voice-agent service (services/voice-agent)
// calls: ai-agent-call-context and provider-ai-agent-result. Every request is
// signed with AI_AGENT_SERVICE_SECRET over `${timestamp}.${body}`; on top of
// that each call carries its own context token, so a leaked signature still
// reaches only an open call.

export const AI_AGENT_MAX_BODY_BYTES = 512_000;

export function aiAgentJson(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Reads the body and checks the service signature; null when it fails. */
export async function readSignedAiAgentBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > AI_AGENT_MAX_BODY_BYTES) return null;
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > AI_AGENT_MAX_BODY_BYTES) return null;
  const secret = Deno.env.get('AI_AGENT_SERVICE_SECRET')?.trim() ?? '';
  const timestamp = request.headers.get('x-ai-agent-timestamp')?.trim() ?? '';
  const supplied = request.headers.get('x-ai-agent-signature')?.trim().toLowerCase() ?? '';
  if (secret.length < 32 || !/^\d{10}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(supplied))
    return null;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null;
  const expected = `sha256=${await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
  return constantTimeEqual(supplied, expected) ? rawBody : null;
}

/** Maps an RPC error to a stable code and HTTP status for the agent. */
export function aiAgentRpcFailure(error: { code?: string; message?: string }) {
  const message = error.message ?? '';
  if (message === 'AI_CALL_TOKEN_INVALID') return aiAgentJson(403, { code: message });
  if (message === 'AUTO_CALL_NOT_FOUND') return aiAgentJson(404, { code: message });
  if (message === 'AI_CALL_CLOSED') return aiAgentJson(409, { code: message });
  if (error.code === '22023') return aiAgentJson(422, { code: 'AI_CALL_RESULT_INVALID' });
  return aiAgentJson(500, { code: 'AI_AGENT_REQUEST_FAILED' });
}
