export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

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
