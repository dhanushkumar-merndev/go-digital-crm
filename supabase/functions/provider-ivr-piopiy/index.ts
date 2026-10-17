import { endActions, loadPiopiyConnection, questionActions } from '../_shared/auto-call.ts';
import { constantTimeEqual } from '../_shared/crypto.ts';
import { type AutoIvrNode, type AutoIvrPrompt, pressedKey } from '../_shared/piopiy.ts';
import { serviceClient } from '../_shared/supabase.ts';

// PIOPIY calls this with the key a customer pressed (or silence) for one
// question. The URL itself names the call, the question and the attempt and
// carries the connection's secret token; the body only supplies the digit.
// The response is the next PCMO action list.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function payloadOf(request: Request, url: URL): Promise<Record<string, unknown>> {
  const fromQuery = Object.fromEntries(
    [...url.searchParams.entries()].filter(([key]) => !['token', 'connection_id'].includes(key)),
  );
  if (request.method !== 'POST') return fromQuery;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  if (!text.trim()) return fromQuery;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? { ...fromQuery, ...parsed } : fromQuery;
  } catch {
    return { ...fromQuery, ...Object.fromEntries(new URLSearchParams(text).entries()) };
  }
}

Deno.serve(async (request) => {
  if (!['GET', 'POST'].includes(request.method)) return json({ code: 405 }, 405);
  const url = new URL(request.url);
  const connectionId = url.searchParams.get('connection_id') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const callId = url.searchParams.get('call') ?? '';
  if (!UUID.test(connectionId) || !UUID.test(callId) || !token) return json({ code: 400 }, 400);
  try {
    const admin = serviceClient();
    const connection = await loadPiopiyConnection(admin, connectionId);
    if (!connection || !constantTimeEqual(token, connection.credential.webhook_secret))
      return json({ code: 403 }, 403);
    if (url.searchParams.get('stage') === 'hangup') return json([{ action: 'hangup' }]);

    const nodeId = url.searchParams.get('node') ?? '';
    const attempt = Number(url.searchParams.get('attempt') ?? '1');
    const payload = await payloadOf(request, url);
    const { data, error } = await admin.rpc('record_auto_ivr_answer', {
      target_connection_id: connection.id,
      target_call_id: callId,
      target_node_id: nodeId,
      target_key: pressedKey(payload),
      target_attempt: Number.isInteger(attempt) ? attempt : 1,
    });
    if (error) return json([{ action: 'hangup' }]);
    const next = data as {
      end: boolean;
      goodbye?: AutoIvrPrompt;
      node_id?: string;
      attempt?: number;
      node?: AutoIvrNode;
    };
    if (next.end || !next.node || !next.node_id)
      return json(await endActions(admin, connection, callId, next.goodbye));
    return json(
      await questionActions(admin, connection, callId, next.node_id, next.node, next.attempt ?? 1),
    );
  } catch {
    return json([{ action: 'hangup' }]);
  }
});
