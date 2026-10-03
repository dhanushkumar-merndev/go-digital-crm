import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609010002_role_session_timeboxes.sql',
  'utf8',
);
const threeHourPolicy = readFileSync(
  'supabase/migrations/202610030006_sensitive_session_three_hours.sql',
  'utf8',
);
const mfaPolicy = readFileSync(
  'supabase/migrations/202608150001_foundation_security_hardening.sql',
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

  it('timeboxes sensitive sessions at three hours and all other sessions at seven days', () => {
    expect(threeHourPolicy).toContain('app_private.requires_mfa(target_organization_id)');
    expect(threeHourPolicy).toContain("interval '3 hours'");
    expect(threeHourPolicy).toContain("interval '7 days'");
    expect(threeHourPolicy).toContain("'SENSITIVE_3_HOURS'");
    expect(migration).toContain("'STANDARD_7_DAYS'");
    expect(migration).toContain('app_private.session_policy_satisfied(target_organization_id)');
  });

  it('applies the short session to every account that requires 2FA', () => {
    expect(mfaPolicy).toContain('profile_row.mfa_required');
    expect(mfaPolicy).toContain('role_row.mfa_required');
    expect(mfaPolicy).toContain(
      "role_row.role_key in ('super_admin', 'business_owner', 'client_admin', 'system_administrator', 'gm_sales')",
    );
    expect(mfaPolicy).toContain(
      "assignment_row.data_scope in ('ALL_BRANCHES', 'ORGANIZATION', 'PLATFORM')",
    );
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
    expect(bootstrap).toContain('SENSITIVE_3_HOURS');
    expect(bootstrap).toContain('STANDARD_7_DAYS');
  });

  it('applies the migration and reports the effective three-hour policy', async () => {
    const db = new PGlite();
    const userId = randomUUID();
    const sessionId = randomUUID();
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create schema app_private;
        create table auth.sessions(id uuid primary key, user_id uuid not null, created_at timestamptz not null);
        create function auth.uid() returns uuid language sql stable as
          $$ select (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid $$;
        create function auth.jwt() returns jsonb language sql stable as
          $$ select current_setting('request.jwt.claims', true)::jsonb $$;
        create function app_private.requires_mfa(uuid) returns boolean language sql stable as
          $$ select current_setting('test.mfa_required')::boolean $$;
        create function app_private.current_session_expires_at(uuid) returns timestamptz language sql stable as
          $$ select now() + interval '5 hours' $$;
        create function public.get_access_context() returns jsonb language sql stable security definer as
          $$ select jsonb_build_object(
            'destination', 'CRM',
            'session_policy', case when app_private.requires_mfa(null) then 'SENSITIVE_5_HOURS' else 'STANDARD_7_DAYS' end
          ) $$;
      `);
      await db.query('insert into auth.sessions(id,user_id,created_at) values($1,$2,now())', [
        sessionId,
        userId,
      ]);
      await db.exec(threeHourPolicy);
      await db.exec(
        `set request.jwt.claims = '${JSON.stringify({ sub: userId, session_id: sessionId })}'`,
      );

      await db.exec("set test.mfa_required = 'true'");
      const sensitive = await db.query<{ hours: number; policy: string }>(`
        select
          extract(epoch from (app_private.current_session_expires_at(null) - session_row.created_at)) / 3600 as hours,
          public.get_access_context() ->> 'session_policy' as policy
        from auth.sessions session_row where session_row.id = '${sessionId}'
      `);
      expect(Number(sensitive.rows[0]?.hours)).toBeCloseTo(3, 5);
      expect(sensitive.rows[0]?.policy).toBe('SENSITIVE_3_HOURS');

      await db.exec("set test.mfa_required = 'false'");
      const standard = await db.query<{ hours: number; policy: string }>(`
        select
          extract(epoch from (app_private.current_session_expires_at(null) - session_row.created_at)) / 3600 as hours,
          public.get_access_context() ->> 'session_policy' as policy
        from auth.sessions session_row where session_row.id = '${sessionId}'
      `);
      expect(Number(standard.rows[0]?.hours)).toBeCloseTo(168, 5);
      expect(standard.rows[0]?.policy).toBe('STANDARD_7_DAYS');
    } finally {
      await db.close();
    }
  }, 15_000);
});
