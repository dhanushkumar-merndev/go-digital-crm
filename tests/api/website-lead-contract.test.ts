import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('Website chat and Lead API boundaries', () => {
  const chat = read('supabase/functions/website-chat-lead/index.ts');
  const api = read('supabase/functions/lead-api/index.ts');
  const issue = read('supabase/functions/integration-website-api-key/index.ts');
  const config = read('supabase/config.toml');
  const migration = read('supabase/migrations/202610141671_website_lead_widget.sql');

  it('chat checks origin, rate limits and captcha before ingesting', () => {
    const ingest = chat.indexOf("rpc('ingest_website_lead'");
    for (const guard of [
      "'ORIGIN_NOT_ALLOWED'",
      'consumeRateLimits(',
      'verifyTurnstile(',
      'mapWebsiteChatAnswers(',
    ]) {
      const at = chat.indexOf(guard);
      expect(at, guard).toBeGreaterThan(-1);
      expect(at, guard).toBeLessThan(ingest);
    }
    expect(chat).toContain('if (input.website) return success(');
  });

  it('chat returns only accepted/duplicate, never lead data', () => {
    expect(chat).toContain('success({ accepted: true, duplicate: result?.duplicate === true }');
    expect(chat).not.toContain('lead_id: result');
  });

  it('Lead API verifies a hashed key in constant time before anything else', () => {
    expect(api).toContain('constantTimeEqual(suppliedHash, keyRow.key_hash)');
    expect(api).toContain('keyRow.revoked_at');
    expect(api.indexOf('constantTimeEqual(')).toBeLessThan(api.indexOf('consumeRateLimit('));
    expect(api.indexOf('consumeRateLimit(')).toBeLessThan(api.indexOf("rpc('ingest_website_lead'"));
  });

  it('API keys are stored as hashes and returned once', () => {
    expect(issue).toContain('key_hash: await sha256Base64Url(apiKey)');
    expect(issue).toContain("'authorize_integration_connection_action'");
    expect(issue).not.toMatch(/key_hash[^\n]*select|select\([^)]*key_hash/);
  });

  it('only the three website boundaries skip gateway JWT verification', () => {
    for (const name of ['website-widget-config', 'website-chat-lead', 'lead-api'])
      expect(config).toMatch(new RegExp(`\\[functions\\.${name}]\\nverify_jwt = false`));
    for (const name of ['integration-connect-website', 'integration-website-api-key'])
      expect(config).toMatch(new RegExp(`\\[functions\\.${name}]\\nverify_jwt = true`));
  });

  it('ingest and rate-limit RPCs are service-role only and key_hash is not readable', () => {
    expect(migration).toMatch(
      /grant execute on function public\.ingest_website_lead\([\s\S]*?\) to service_role;/,
    );
    expect(migration).toMatch(
      /from public, anon, authenticated;\ngrant execute on function public\.ingest_website_lead/,
    );
    expect(migration).toContain(
      'grant execute on function public.consume_public_rate_limit(text, integer, integer) to service_role;',
    );
    const columnGrant = migration.slice(
      migration.indexOf('grant select ('),
      migration.indexOf(') on public.lead_api_keys to authenticated'),
    );
    expect(columnGrant).not.toContain('key_hash');
  });

  it('the loader ships no secrets and the iframe trusts only the browser-reported parent', () => {
    const loader = read('public/widget/v1/gdm-chat.js');
    expect(loader).not.toMatch(/service_role|SUPABASE_|gdm_live_/);
    expect(loader).toContain('event.origin !== crmOrigin');
    const embed = read('src/features/website-chat/website-chat-embed.tsx');
    expect(embed).toContain('window.location.ancestorOrigins');
    expect(read('src/app/embed/chat/[key]/page.tsx')).not.toContain('search.origin');
  });

  it('the live proxy frames the chat per widget key before any session gate', () => {
    const proxy = read('src/proxy.ts');
    const embedBranch = proxy.indexOf('frame-ancestors ${await embedChatFrameAncestors(pathname)}');
    expect(embedBranch).toBeGreaterThan(-1);
    expect(embedBranch).toBeLessThan(proxy.indexOf('supabase.auth.getClaims()'));
    expect(proxy).toContain('lottie|js|map');
    expect(read('src/features/website-chat/embed-frame-policy.ts')).toContain(
      `["'self'", ...origins]`,
    );
  });
});
