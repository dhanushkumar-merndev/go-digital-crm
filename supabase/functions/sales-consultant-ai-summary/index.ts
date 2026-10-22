import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient, serviceClient } from '../_shared/supabase.ts';
import { readWorkspaceCache } from '../_shared/workspace-cache.ts';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_SCHEMA_VERSION = 2;
const TIMEZONE = 'Asia/Kolkata';

// One credit per generated summary (AGENTS.md section 20). Reading the cached
// summary is free; only a call that reaches the AI provider is charged, and a
// failed call is refunded.
const SUMMARY_CREDITS = 1;
const SUMMARY_FEATURE = 'DASHBOARD_AI_SUMMARY';

const requestSchema = z.object({
  force_refresh: z.boolean().optional().default(false),
  // The click that asked for the summary, so a retried request is charged once.
  request_id: z.uuid().optional(),
});
const contextSchema = z.object({
  destination: z.literal('CRM'),
  user_id: z.uuid(),
  role_key: z.enum(['sales-consultant', 'telecaller']),
  scope_key: z.string().min(1),
  organization_id: z.uuid(),
  permissions: z.array(z.string()),
});
const salesSignalsSchema = z.object({
  metrics: z.object({
    hot_leads: z.object({ value: z.coerce.number().int().nonnegative() }),
    followups_today: z.object({ value: z.coerce.number().int().nonnegative() }),
  }),
  attention: z.array(z.object({ key: z.string(), value: z.coerce.number().int().nonnegative() })),
  pipeline: z.array(z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() })),
});
const telecallerSignalsSchema = z.object({
  kpis: z.object({
    open_leads: z.coerce.number().int().nonnegative(),
    new_leads_today: z.coerce.number().int().nonnegative(),
    followups_due_today: z.coerce.number().int().nonnegative(),
    followups_overdue: z.coerce.number().int().nonnegative(),
    calls_today: z.coerce.number().int().nonnegative(),
  }),
  pipeline: z.array(z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() })),
});

type Signals =
  | { role: 'sales-consultant'; data: z.infer<typeof salesSignalsSchema> }
  | { role: 'telecaller'; data: z.infer<typeof telecallerSignalsSchema> };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The free, rule-based text: shown when no AI provider is configured or the
// provider call fails (and its credit is refunded). Counts only; the stage
// numbers are not one cohort, so no stage-to-stage percentage.
function ruleBasedSummary(signals: Signals) {
  let summary: string;
  if (signals.role === 'sales-consultant') {
    const { data } = signals;
    const overdue = data.attention.find((item) => item.key === 'OVERDUE_FOLLOWUPS')?.value ?? 0;
    const assigned = data.pipeline[0]?.value ?? 0;
    const booked = data.pipeline.at(-1)?.value ?? 0;
    summary = `Prioritize ${plural(data.metrics.hot_leads.value, 'hot lead')} and ${plural(data.metrics.followups_today.value, 'follow-up')} today. This month: ${plural(assigned, 'lead')} assigned and ${plural(booked, 'booking')}. ${overdue ? `Clear ${plural(overdue, 'overdue follow-up')} first.` : 'No overdue follow-ups are waiting.'}`;
  } else {
    const { kpis } = signals.data;
    summary = `${plural(kpis.new_leads_today, 'new lead')} came in today and ${plural(kpis.followups_due_today, 'follow-up')} are due. ${kpis.followups_overdue ? `Clear ${plural(kpis.followups_overdue, 'overdue follow-up')} first, then call the new leads.` : 'No follow-ups are overdue, so start with the new leads.'} You have ${plural(kpis.open_leads, 'open lead')} and have made ${plural(kpis.calls_today, 'call')} today.`;
  }
  return {
    summary,
    generated_at: new Date().toISOString(),
    provider: 'RULE_BASED' as const,
    credits_charged: 0,
  };
}

const coachPrompt: Record<Signals['role'], string> = {
  'sales-consultant':
    'You are an automobile dealership sales coach. Give a concise, factual 2-4 sentence action summary for a sales consultant. Use only the supplied aggregate dashboard signals. Never invent customer facts, targets, dates or percentages.',
  telecaller:
    'You are an automobile dealership telecalling coach. Give a concise, factual 2-4 sentence action summary for a telecaller: who to call first and what to clear. Use only the supplied aggregate dashboard signals. Never invent customer facts, targets, dates or percentages.',
};

async function providerSummary(signals: Signals, apiKey: string, model: string) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 220,
      messages: [
        { role: 'system', content: coachPrompt[signals.role] },
        { role: 'user', content: JSON.stringify(signals.data) },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const generated = payload?.choices?.[0]?.message?.content?.trim();
  return response.ok && generated ? generated.replace(/\s+/g, ' ').slice(0, 2_000) : null;
}

class InsufficientCreditsError extends Error {}

/**
 * Reserve the credit, call the provider, then commit on success or reverse on
 * failure, so the ledger only ever keeps a charge for a summary that was made.
 */
async function generateSummary(input: {
  signals: Signals;
  organizationId: string;
  referenceId: string;
}) {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  const model = Deno.env.get('GROQ_ANALYSIS_MODEL');
  if (!apiKey || !model) return ruleBasedSummary(input.signals);

  const admin = serviceClient();
  const { data: reservationId, error: reserveError } = await admin.rpc('reserve_ai_credits', {
    target_organization_id: input.organizationId,
    target_amount: SUMMARY_CREDITS,
    target_feature: SUMMARY_FEATURE,
    target_reference_id: input.referenceId,
  });
  if (reserveError?.message.includes('INSUFFICIENT_CREDITS')) throw new InsufficientCreditsError();
  if (reserveError || !reservationId) throw new Error('AI_CREDIT_RESERVATION_FAILED');

  let generated: string | null = null;
  try {
    generated = await providerSummary(input.signals, apiKey, model);
  } catch {
    generated = null;
  }
  if (!generated) {
    await admin.rpc('reverse_ai_credit_reservation', { target_reservation_id: reservationId });
    return ruleBasedSummary(input.signals);
  }
  await admin.rpc('commit_ai_credit_reservation', { target_reservation_id: reservationId });
  return {
    summary: generated,
    generated_at: new Date().toISOString(),
    provider: 'AI' as const,
    credits_charged: SUMMARY_CREDITS,
  };
}

async function loadSignals(
  client: ReturnType<typeof authenticatedClient>,
  role: Signals['role'],
): Promise<Signals> {
  if (role === 'sales-consultant') {
    const { data, error } = await client.rpc('get_sales_consultant_dashboard_summary', {
      target_timezone: TIMEZONE,
    });
    if (error) throw error;
    return { role, data: salesSignalsSchema.parse(data) };
  }
  const { data, error } = await client.rpc('get_tenant_dashboard_summary', {
    target_days: 14,
    target_timezone: TIMEZONE,
  });
  if (error) throw error;
  return { role, data: telecallerSignalsSchema.parse(data) };
}

Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'POST')
    return failure('METHOD_NOT_ALLOWED', 'Only POST is supported.', requestId, 405);

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success)
      return failure('INVALID_PAYLOAD', 'The summary request is invalid.', requestId, 422);

    const client = authenticatedClient(request);
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);
    const { data: claims, error: claimsError } = await client.auth.getClaims(accessToken);
    const userId = z.uuid().safeParse(claims?.claims?.sub);
    if (claimsError || !userId.success)
      return failure('UNAUTHENTICATED', 'Authentication is required.', requestId, 401);

    const contextResponse = await client.rpc('get_workspace_bootstrap');
    const context = contextSchema.safeParse(contextResponse.data);
    if (
      contextResponse.error ||
      !context.success ||
      context.data.user_id !== userId.data ||
      !context.data.permissions.includes('lead.view')
    )
      return failure('PERMISSION_DENIED', 'Summary access is not available.', requestId, 403);

    const cached = await readWorkspaceCache({
      resource: 'sales-consultant-ai-summary',
      version: CACHE_SCHEMA_VERSION,
      ttlSeconds: CACHE_TTL_SECONDS,
      forceRefresh: parsed.data.force_refresh,
      fingerprintInput: {
        resource: 'sales-consultant-ai-summary',
        user_id: userId.data,
        role_key: context.data.role_key,
        organization_id: context.data.organization_id,
        scope_key: context.data.scope_key,
        timezone: TIMEZONE,
      },
      load: async () =>
        generateSummary({
          signals: await loadSignals(client, context.data.role_key),
          organizationId: context.data.organization_id,
          referenceId: `dashboard-summary:${userId.data}:${parsed.data.request_id ?? requestId}`,
        }),
    });

    // Only the request that generated the summary was charged; a saved summary
    // (HIT, STALE) or one another request was already making (COALESCED) is free.
    const generatedHere = ['MISS', 'BYPASS', 'FALLBACK'].includes(cached.diagnostic.status);
    return success(
      {
        ...cached.value,
        credits_charged: generatedHere ? cached.value.credits_charged : 0,
        cache: cached.diagnostic,
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof InsufficientCreditsError)
      return failure(
        'INSUFFICIENT_CREDITS',
        'Your dealership has no AI credits left for this summary.',
        requestId,
        409,
      );
    return failure(
      'SALES_SUMMARY_FAILED',
      'The AI sales summary could not be generated.',
      requestId,
      502,
    );
  }
});
