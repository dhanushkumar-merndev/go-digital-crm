export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, apikey, content-type, idempotency-key, x-client-info, x-request-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export function preflight(request: Request) {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: jsonHeaders });
}

export function requestId(request: Request) {
  const candidate = request.headers.get('x-request-id');
  return candidate &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export function success<T>(data: T, requestId: string, status = 200) {
  return new Response(JSON.stringify({ ok: true, data, error: null, request_id: requestId }), {
    status,
    headers: jsonHeaders,
  });
}

export function failure(code: string, message: string, requestId: string, status: number) {
  return new Response(
    JSON.stringify({ ok: false, data: null, error: { code, message }, request_id: requestId }),
    { status, headers: jsonHeaders },
  );
}
