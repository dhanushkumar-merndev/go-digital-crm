import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610030002_optimize_scoped_followup_workspace.sql',
  'utf8',
);

describe('manager Follow-ups workspace performance', () => {
  it('resolves permission-bound scopes once instead of checking access for every row', () => {
    expect(migration).toContain('get_scoped_followup_workspace_filtered_page');
    expect(migration).toContain('resolve_permission_record_scope');
    expect(migration).toContain("array['followup.view']");
    expect(migration).toContain("array['lead.view']");
    expect(migration).toContain("array['customer.view']");

    const functionBody = migration.slice(
      migration.indexOf(
        'create or replace function app_private.get_scoped_followup_workspace_filtered_page',
      ),
      migration.indexOf(
        'revoke all on function app_private.get_scoped_followup_workspace_filtered_page',
      ),
    );
    expect(functionBody).not.toContain('app_private.can_access_record(');
    expect(functionBody).not.toContain('app_private.can_access_lead(');
    expect(functionBody).not.toContain('app_private.can_access_customer(');
  });

  it('preserves the existing personal-role fast paths with a guarded live-body patch', () => {
    expect(migration).toContain("access_context->>'destination'");
    expect(migration).toContain('pg_get_functiondef(');
    expect(migration).toContain('FOLLOWUP_SCOPE_PATCH_MISMATCH');
    expect(migration).toContain('-- (unchanged logic from 202608290009)');
  });
});
