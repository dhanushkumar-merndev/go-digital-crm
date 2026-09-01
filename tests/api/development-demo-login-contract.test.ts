import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync('src/app/api/development/demo-role-login/route.ts', 'utf8');
const switcher = readFileSync('src/components/shared/role-switcher.tsx', 'utf8');
const runtime = readFileSync('src/lib/runtime/runtime-mode.ts', 'utf8');
const demoLogin = readFileSync('src/lib/auth/development-demo-role-login.ts', 'utf8');

describe('development demo role login', () => {
  it('remains closed outside the explicit development-only flag', () => {
    expect(runtime).toContain("nodeEnv === 'development' && demoRoleLoginFlag === 'true'");
    expect(route).toContain('isDevelopmentDemoRoleLoginEnabled()');
    expect(route).toContain("return privateJson({ error: 'NOT_FOUND' }, 404)");
  });

  it('upgrades privileged demo sessions to real AAL2 without weakening production MFA', () => {
    for (const role of [
      'super-admin',
      'business-owner',
      'client-admin',
      'system-administrator',
      'gm-sales',
    ]) {
      expect(demoLogin).toContain(`'${role}'`);
    }
    expect(route).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(route).toContain('admin.auth.admin.mfa.deleteFactor');
    expect(route).toContain("factorType: 'totp'");
    expect(route).toContain('supabase.auth.mfa.challengeAndVerify');
    expect(route).toContain("assurance.currentLevel !== 'aal2'");
    expect(route).toContain('request.cookies.set(name, value)');
  });

  it('uses a document navigation after changing authentication cookies', () => {
    expect(switcher).toContain("window.location.replace('/')");
    const demoBranch = switcher.slice(
      switcher.indexOf('if (realDemoLogin)'),
      switcher.indexOf('startTransition(() => {', switcher.indexOf('if (realDemoLogin)')),
    );
    expect(demoBranch).not.toContain('router.refresh()');
    expect(demoBranch).not.toContain("router.replace('/')");
  });
});
