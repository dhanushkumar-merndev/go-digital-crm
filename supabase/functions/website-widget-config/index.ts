import { failure, jsonHeaders, preflight, requestId as getRequestId } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { turnstileSiteKey } from '../_shared/turnstile.ts';
import {
  loadWebsiteConnectionByPublicKey,
  websiteConnectionBranches,
  websiteModelNames,
} from '../_shared/website-lead.ts';
import { WEBSITE_PUBLIC_KEY_PATTERN } from '../../../src/lib/providers/website-lead-adapter.ts';

// Public, read-only presentation data for the chat iframe. allowed_origins is
// returned because the embed page builds its CSP frame-ancestors and
// postMessage targets from it; those are the dealer's own public websites.
// Team routing, lead data and credentials never leave the server.
Deno.serve(async (request) => {
  const preflightResponse = preflight(request);
  if (preflightResponse) return preflightResponse;
  const requestId = getRequestId(request);
  if (request.method !== 'GET')
    return failure('METHOD_NOT_ALLOWED', 'Only GET is supported.', requestId, 405);
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!WEBSITE_PUBLIC_KEY_PATTERN.test(key))
    return failure('WIDGET_NOT_FOUND', 'This chat widget is not available.', requestId, 404);
  try {
    const admin = serviceClient();
    const connection = await loadWebsiteConnectionByPublicKey(admin, key);
    if (!connection || !connection.config.widget_enabled)
      return failure('WIDGET_NOT_FOUND', 'This chat widget is not available.', requestId, 404);
    const config = connection.config;
    const needsBranches = config.questions.some((question) => question.type === 'branch_picker');
    const needsModels = config.questions.some((question) => question.type === 'model_picker');
    const [branches, models] = await Promise.all([
      needsBranches ? websiteConnectionBranches(admin, connection) : Promise.resolve([]),
      needsModels ? websiteModelNames(admin, connection.organization_id) : Promise.resolve([]),
    ]);
    const data = {
      title: config.title,
      greeting: config.greeting,
      success_message: config.success_message,
      accent_color: config.accent_color,
      allowed_origins: config.allowed_origins,
      questions: config.questions,
      models,
      branches: branches.map((branch) => ({ id: branch.id, name: branch.name })),
      turnstile_site_key: turnstileSiteKey(),
    };
    return new Response(JSON.stringify({ ok: true, data, error: null, request_id: requestId }), {
      status: 200,
      headers: { ...jsonHeaders, 'cache-control': 'public, max-age=300' },
    });
  } catch {
    return failure('WIDGET_CONFIG_FAILED', 'The chat widget could not be loaded.', requestId, 500);
  }
});
