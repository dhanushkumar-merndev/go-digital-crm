import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609010002_role_session_timeboxes.sql',
  'utf8',
);
const proxy = readFileSync('proxy.ts', 'utf8');
const guard = readFileSync('src/features/auth/session-expiry-guard.tsx', 'utf8');
const bootstrap = readFileSync('src/lib/auth/workspace-bootstrap.ts', 'utf8');
const mobileRoute = readFileSync('mobile/src/lib/session-route.ts', 'utf8');
const mobilePolicy = readFileSync('mobile/src/lib/session-policy.ts', 'utf8');
const mobileLayout = readFileSync('mobile/app/_layout.tsx', 'utf8');

describe('role-aware session policy', () => {
  it('uses the stable Supabase Auth session and the existing MFA policy', () => {
    expect(migration).toContain("auth.jwt() ->> 'session_id'");
    expect(migration).toContain('from auth.sessions session_row');
    expect(migration).toContain('session_row.user_id = auth.uid()');
    expect(migration).toContain('app_private.requires_mfa(target_organization_id)');
  });

  it('timeboxes sensitive sessions at five hours and all other sessions at seven days', () => {
    expect(migration).toContain("interval '5 hours'");
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("'SENSITIVE_5_HOURS'");
    expect(migration).toContain("'STANDARD_7_DAYS'");
    expect(migration).toContain('app_private.session_policy_satisfied(target_organization_id)');
  });

  it('returns an explicit expiry decision and clears expired browser/mobile sessions', () => {
    expect(migration).toContain("'reason', 'SESSION_EXPIRED'");
    expect(migration).toContain("'session_expires_at', session_expires_at");
    expect(proxy).toContain("context.reason === 'SESSION_EXPIRED'");
    expect(proxy).toContain("signOut({ scope: 'local' })");
    expect(guard).toContain("router.replace('/login?reason=session-expired')");
    expect(mobileRoute).toContain("context.reason === 'SESSION_EXPIRED'");
    expect(mobilePolicy).toContain('enforceMobileSessionPolicy');
    expect(mobilePolicy).toContain("signOut({ scope: 'local' })");
    expect(mobileLayout).toContain("state === 'active'");
    expect(mobileLayout).toContain("event === 'TOKEN_REFRESHED'");
    expect(bootstrap).toContain('SENSITIVE_5_HOURS');
    expect(bootstrap).toContain('STANDARD_7_DAYS');
  });
});
