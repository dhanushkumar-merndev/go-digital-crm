import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { clientIp, consumeRateLimits } from '../_shared/rate-limit.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { verifyTurnstile, WEBSITE_CHAT_TURNSTILE_ACTION } from '../_shared/turnstile.ts';
import {
  isCrmOrigin,
  loadWebsiteConnectionByPublicKey,
  websiteConnectionBranches,
  websiteIngestFailure,
  websiteModelNames,
} from '../_shared/website-lead.ts';
import {
  mapWebsiteChatAnswers,
  normalizeWebsiteOrigin,
  WEBSITE_LIMITS,
  WEBSITE_PUBLIC_KEY_PATTERN,
} from '../../../src/lib/providers/website-lead-adapter.ts';

const bodySchema = z.object({
  key: z.string().regex(WEBSITE_PUBLIC_KEY_PATTERN),
  chat_id: z.uuid(),
  answers: z.record(z.string().max(40), z.unknown()),
  turnstile_token: z.string().max(2048).optional(),
  // Honeypot: a field no human sees. Anything in it is a bot.
  website: z.string().max(500).optional(),
  parent_origin: z.string().max(300).optional(),
  page_url: z.string().max(1000).optional(),
});

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > WEBSITE_LIMITS.maxSubmissionBytes)
    return failure('PAYLOAD_TOO_LARGE', 'The submission is too large.', requestId, 413);

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > WEBSITE_LIMITS.maxSubmissionBytes)
      return failure('PAYLOAD_TOO_LARGE', 'The submission is too large.', requestId, 413);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return failure('INVALID_JSON', 'Malformed JSON payload.', requestId, 400);
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The chat submission is invalid.', requestId, 422);
    const input = parsed.data;
    // Bots get a normal-looking success and nothing is stored.
    if (input.website) return success({ accepted: true, duplicate: false }, requestId, 201);

    if (!isCrmOrigin(request.headers.get('origin')))
      return failure('ORIGIN_NOT_ALLOWED', 'This website cannot submit leads.', requestId, 403);

    const admin = serviceClient();
    const connection = await loadWebsiteConnectionByPublicKey(admin, input.key);
    if (!connection || !connection.config.widget_enabled)
      return failure('WIDGET_NOT_FOUND', 'This chat widget is not available.', requestId, 404);

    const allowedOrigins = connection.config.allowed_origins;
    const parentOrigin = input.parent_origin ? normalizeWebsiteOrigin(input.parent_origin) : null;
    if (allowedOrigins.length > 0 && (!parentOrigin || !allowedOrigins.includes(parentOrigin)))
      return failure('ORIGIN_NOT_ALLOWED', 'This website cannot submit leads.', requestId, 403);

    const ip = clientIp(request) ?? 'unknown';
    const limited = await consumeRateLimits(admin, [
      { bucket: `chat:ip:${connection.id}:${ip}`, limit: 5, windowSeconds: 600 },
      { bucket: `chat:ip:${ip}`, limit: 20, windowSeconds: 3600 },
      { bucket: `chat:connection:${connection.id}`, limit: 300, windowSeconds: 3600 },
    ]);
    if (!limited.allowed)
      return failure(
        'RATE_LIMITED',
        'Too many submissions. Please try again later.',
        requestId,
        429,
        {
          retry_after_ms: limited.retry_after_ms,
        },
      );

    const captcha = await verifyTurnstile(
      input.turnstile_token,
      ip === 'unknown' ? null : ip,
      WEBSITE_CHAT_TURNSTILE_ACTION,
    );
    if (!captcha.ok)
      return failure(
        captcha.code,
        'Please complete the verification and try again.',
        requestId,
        403,
      );

    const needsModels = connection.config.questions.some(
      (question) => question.type === 'model_picker',
    );
    const [branches, models] = await Promise.all([
      websiteConnectionBranches(admin, connection),
      needsModels ? websiteModelNames(admin, connection.organization_id) : Promise.resolve([]),
    ]);
    if (branches.length === 0)
      return failure(
        'NO_BRANCH_AVAILABLE',
        'This lead source has no active showroom.',
        requestId,
        409,
      );

    const mapped = mapWebsiteChatAnswers(connection.config, input.answers, { models, branches });
    if (!mapped.ok)
      return failure('INVALID_ANSWER', mapped.error, requestId, 422, {
        question_id: mapped.question_id,
      });
    const lead = mapped.value;

    const { data, error } = await admin.rpc('ingest_website_lead', {
      target_organization_id: connection.organization_id,
      target_connection_id: connection.id,
      target_branch_id: lead.branch_id ?? branches[0].id,
      target_external_lead_id: `chat:${input.chat_id}`,
      target_source_detail: `Website chat: ${connection.display_name}`.slice(0, 255),
      target_campaign: null,
      target_customer_name: lead.customer_name,
      target_phone: lead.phone,
      target_normalized_phone: lead.phone,
      target_email: lead.email ?? null,
      target_interested_model: lead.interested_model ?? null,
      target_requirements: lead.requirements,
      target_raw_payload: {
        channel: 'CHAT',
        answers: lead.transcript,
        parent_origin: parentOrigin,
        page_url: input.page_url?.slice(0, 1000) ?? null,
        captcha_verified: captcha.enforced,
      },
      target_request_id: requestId,
    });
    if (error) {
      const known = websiteIngestFailure(error.message);
      if (known) return failure(known.code, known.message, requestId, known.status);
      throw error;
    }
    const result = data as { duplicate?: boolean } | null;
    return success({ accepted: true, duplicate: result?.duplicate === true }, requestId, 201);
  } catch {
    return failure(
      'WEBSITE_CHAT_FAILED',
      'We could not send your details. Please try again.',
      requestId,
      500,
    );
  }
});
