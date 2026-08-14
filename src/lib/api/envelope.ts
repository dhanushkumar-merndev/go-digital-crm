export type ApiError = { code: string; message: string };
export type ApiEnvelope<T> =
  | { ok: true; data: T; error: null; request_id: string }
  | { ok: false; data: null; error: ApiError; request_id: string };

export const success = <T>(data: T, requestId = crypto.randomUUID()): ApiEnvelope<T> => ({
  ok: true,
  data,
  error: null,
  request_id: requestId,
});
export const failure = (
  code: string,
  message: string,
  requestId = crypto.randomUUID(),
): ApiEnvelope<never> => ({
  ok: false,
  data: null,
  error: { code, message },
  request_id: requestId,
});
