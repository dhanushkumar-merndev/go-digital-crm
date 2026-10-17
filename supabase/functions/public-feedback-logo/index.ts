import { GetObjectCommand } from 'npm:@aws-sdk/client-s3@3.1110.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1110.0';
import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { clientIp, consumeRateLimits } from '../_shared/rate-limit.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { tigrisClient } from '../_shared/tigris.ts';

// The customer feedback page has no session: the 64-hex feedback token is the
// only credential. It resolves to the branch logo and nothing else, and only
// while the token is live and unspent (resolve_public_feedback_logo).
const schema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const logoSchema = z.object({
  bucket: z.string().min(1),
  object_key: z.string().min(1),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});
const URL_TTL_SECONDS = 10 * 60;

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The logo request is invalid.', requestId, 422);

    const admin = serviceClient();
    const ip = clientIp(request) ?? 'unknown';
    const limited = await consumeRateLimits(admin, [
      { bucket: `feedback-logo:ip:${ip}`, limit: 30, windowSeconds: 600 },
    ]);
    if (!limited.allowed)
      return failure('RATE_LIMITED', 'Too many requests. Please try again later.', requestId, 429);

    const { data, error } = await admin.rpc('resolve_public_feedback_logo', {
      target_token: parsed.data.token,
    });
    if (error) throw error;
    const logo = logoSchema.safeParse(data);
    if (!logo.success)
      return failure('FEEDBACK_LOGO_NOT_FOUND', 'No logo is available.', requestId, 404);

    const logoUrl = await getSignedUrl(
      tigrisClient(),
      new GetObjectCommand({
        Bucket: logo.data.bucket,
        Key: logo.data.object_key,
        ResponseContentType: logo.data.mime_type,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
    return success(
      {
        logo_url: logoUrl,
        expires_at: new Date(Date.now() + URL_TTL_SECONDS * 1_000).toISOString(),
      },
      requestId,
    );
  } catch {
    return failure('FEEDBACK_LOGO_FAILED', 'The logo could not be loaded.', requestId, 500);
  }
});
