import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Helpers called from RLS policies. Revoking EXECUTE from `authenticated` turns
// a filtered read into a 42501 error (see 202610050003), so the last migration
// that touches each grant must leave it granted.
const policyHelpers = [
  'app_private.can_administer_tenant_user(uuid, uuid, text)',
  'app_private.can_access_sales_escalation(uuid, uuid)',
  'app_private.operational_case_permission(uuid, text, text)',
];

const migrations = readdirSync('supabase/migrations')
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(`supabase/migrations/${file}`, 'utf8'));

function lastPrivilegeChange(signature: string) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/, /g, ',\\s*');
  const statement = new RegExp(
    `(grant|revoke)\\s+(?:all|execute)\\s+on\\s+function\\s+${escaped}[^;]*;`,
    'gi',
  );
  let last: string | null = null;
  for (const sql of migrations)
    for (const match of sql.matchAll(statement)) last = match[0].toLowerCase();
  return last;
}

describe('RLS policy helpers stay executable by signed-in users', () => {
  it.each(policyHelpers)('%s ends granted to authenticated', (signature) => {
    const last = lastPrivilegeChange(signature);
    expect(last).not.toBeNull();
    expect(last).toMatch(/^grant/);
    expect(last).toContain('authenticated');
  });
});
