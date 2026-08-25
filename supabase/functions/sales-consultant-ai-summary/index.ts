import { z } from 'npm:zod@4';
import { failure, preflight, requestId as getRequestId, success } from '../_shared/http.ts';
import { authenticatedClient } from '../_shared/supabase.ts';
import { readWorkspaceCache } from '../_shared/workspace-cache.ts';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const CACHE_SCHEMA_VERSION = 1;
const TIMEZONE = 'Asia/Kolkata';

const requestSchema = z.object({ force_refresh: z.boolean().optional().default(false) });
const contextSchema = z.object({
  destination: z.literal('CRM'),
  user_id: z.uuid(),
  role_key: z.literal('sales-consultant'),
  scope_key: z.string().min(1),
  organization_id: z.uuid(),
  permissions: z.array(z.string()),
});
const summaryDataSchema = z.object({
  metrics: z.object({
    hot_leads: z.object({ value: z.coerce.number().int().nonnegative() }),
    followups_today: z.object({ value: z.coerce.number().int().nonnegative() }),
  }),
  attention: z.array(z.object({ key: z.string(), value: z.coerce.number().int().nonnegative() })),
  pipeline: z.array(z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() })),
});

function createSummary(data: z.infer<typeof summaryDataSchema>) {
  const hotLeads = data.metrics.hot_leads.value;
  const followups = data.metrics.followups_today.value;
  const overdue = data.attention.find((item) => item.key === 'OVERDUE_FOLLOWUPS')?.value ?? 0;
  const starting = data.pipeline[0]?.value ?? 0;
  const next = data.pipeline[1];
  const movement = starting > 0 && next ? ((next.value / starting) * 100).toFixed(1) : '0.0';
  const focus = overdue
    ? `Clear ${overdue} overdue follow-up${overdue === 1 ? '' : 's'} first.`
    : 'No overdue follow-ups are waiting.';

  return {
    summary: `Prioritize ${hotLeads} hot lead${hotLeads === 1 ? '' : 's'} and ${followups} follow-up${followups === 1 ? '' : 's'} today. ${next ? `${movement}% of starting leads have reached ${next.name}.` : 'Pipeline movement is not available yet.'} ${focus}`,
    generated_at: new Date().toISOString(),
    provider: 'RULE_BASED' as const,
  };
}

async function generateAiSummary(data: z.infer<typeof summaryDataSchema>) {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  const model = Deno.env.get('GROQ_ANALYSIS_MODEL');
  if (!apiKey || !model) return createSummary(data);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_completion_tokens: 220,
        messages: [
          {
            role: 'system',
            content:
              'You are an automobile dealership sales coach. Give a concise, factual 2-4 sentence action summary. Use only the supplied aggregate dashboard signals. Never invent customer facts, targets, or dates.',
          },
          { role: 'user', content: JSON.stringify(data) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const generated = payload?.choices?.[0]?.message?.content?.trim();
    if (!response.ok || !generated) return createSummary(data);
    return {
      summary: generated.replace(/\s+/g, ' ').slice(0, 2_000),
      generated_at: new Date().toISOString(),
      provider: 'AI' as const,
    };
  } catch {
    return createSummary(data);
  }
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
        organization_id: context.data.organization_id,
        scope_key: context.data.scope_key,
        timezone: TIMEZONE,
      },
      load: async () => {
        const { data, error } = await client.rpc('get_sales_consultant_dashboard_summary', {
          target_timezone: TIMEZONE,
        });
        if (error) throw error;
        return generateAiSummary(summaryDataSchema.parse(data));
      },
    });

    return success({ ...cached.value, cache: cached.diagnostic }, requestId);
  } catch {
    return failure(
      'SALES_SUMMARY_FAILED',
      'The AI sales summary could not be generated.',
      requestId,
      502,
    );
  }
});
