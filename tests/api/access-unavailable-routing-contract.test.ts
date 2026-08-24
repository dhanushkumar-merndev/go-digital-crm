import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const proxy = readFileSync('proxy.ts', 'utf8');
const home = readFileSync('src/app/page.tsx', 'utf8');
const roleLayout = readFileSync('src/app/[role]/layout.tsx', 'utf8');
const accessPage = readFileSync('src/app/access/[state]/page.tsx', 'utf8');

describe('workspace access failure routing', () => {
  it('keeps transient bootstrap failures fail-closed without calling the account locked', () => {
    expect(proxy).toContain("pathname === '/access/unavailable'");
    expect(proxy).toContain("redirectWithSessionCookies('/access/unavailable'");
    expect(proxy).toContain('WORKSPACE_BOOTSTRAP_UNAVAILABLE');
    expect(proxy).not.toContain(
      "if (error || !data) return redirectWithSessionCookies('/access/locked'",
    );
    expect(home).toContain("if (error || !data) redirect('/access/unavailable')");
    expect(roleLayout).toContain(
      "if (bootstrapFailed || !context) redirect('/access/unavailable')",
    );
  });

  it('reserves the locked screen for an explicit authoritative lock decision', () => {
    expect(proxy).toContain("ACCOUNT_LOCKED: '/access/locked'");
    expect(home).toContain(
      "if (context.destination === 'ACCOUNT_LOCKED') redirect('/access/locked')",
    );
    expect(roleLayout).toContain(
      "if (context.destination === 'ACCOUNT_LOCKED') redirect('/access/locked')",
    );
  });

  it('provides a retryable neutral state and avoids unknown-state lock messaging', () => {
    expect(accessPage).toContain('unavailable: {');
    expect(accessPage).toContain('Your account has not been marked inactive.');
    expect(accessPage).toContain('states[state as keyof typeof states] ?? states.unavailable');
    expect(accessPage).toContain("router.replace('/')");
    expect(accessPage).toContain("state === 'locked' || state === 'unavailable'");
  });
});
