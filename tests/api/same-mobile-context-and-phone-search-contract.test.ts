import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202610090401_same_mobile_context_and_phone_search.sql',
  'utf8',
);
const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

function functionBody(signature: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${signature}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('$function$;', start);
  return migration.slice(start, end);
}

describe('same-mobile context for Sales Consultants', () => {
  const history = functionBody('public.get_lead_phone_history');

  it('keeps the workspace scope as in_scope and widens only for consultants', () => {
    expect(history).toContain('as in_scope');
    expect(history).toMatch(/where phone_lead\.in_scope\s+or \(\s+actor_is_sales_consultant/);
    expect(history).toContain('phone_lead.branch_id = any(workspace_scope.owner_branch_ids)');
  });

  it('returns out-of-scope rows with a reduced field set', () => {
    const contextRow = history.slice(history.indexOf('else jsonb_build_object('));
    expect(contextRow).toContain("'context_only', true");
    expect(contextRow).toContain("'read_only', true");
    for (const hidden of ["'email'", "'customer_id'", "'lost_reason'", "'external_lead_id'"]) {
      expect(contextRow.slice(0, contextRow.indexOf('end'))).not.toContain(hidden);
    }
    expect(history).toContain("|| jsonb_build_object('context_only', false)");
  });

  it('counts the same set for the consultant group badge', () => {
    const page = functionBody('app_private.get_sales_role_lead_workspace_page');
    expect(page).toContain('when actor_is_sales_consultant and lead_row.normalized_phone');
    expect(page).toContain('end as phone_lead_count');
  });

  it('keeps a viewer-owned lead in an expanded group workable', () => {
    expect(workspace).toContain('const contextLeadIds = useMemo(');
    expect(workspace).toContain('lead.assigned_user_id !== currentUserId');
    expect(workspace).toContain('if (contextLeadIds.has(row.original.id)) return null;');
  });

  it('gives context rows no actions: the context check runs before read-only', () => {
    const actions = workspace.slice(workspace.indexOf("id: 'actions',"));
    expect(actions.indexOf('if (contextLeadIds.has(row.original.id)) return null;')).toBeLessThan(
      actions.indexOf('if (row.original.read_only) {'),
    );
  });

  it('leaves only Cancel transfer on a read-only row', () => {
    const actions = workspace.slice(workspace.indexOf("id: 'actions',"));
    const readOnly = actions.slice(
      actions.indexOf('if (row.original.read_only) {'),
      actions.indexOf(
        'return (\n            <div className="flex items-center justify-end gap-0.5">',
      ),
    );
    expect(readOnly).not.toContain('View');
    expect(readOnly).not.toContain('`Transferred to');
    expect(readOnly).toContain('Cancel transfer');
    expect(readOnly).toContain("row.original.lifecycle_status === 'Appointment Scheduled'");
  });
});

describe('mobile search matches +91 and 91 storage', () => {
  it('adds the country-code arms to every patched search', () => {
    const bodies = migration.split('CREATE OR REPLACE FUNCTION').slice(1);
    expect(bodies).toHaveLength(9);
    for (const body of bodies.filter((item) => item.includes('search_phone_digits'))) {
      expect(body).toContain("like '+91' || nullif(ltrim(search_phone_digits, '0'), '') || '%'");
    }
  });

  it('keeps the lead-list walk a superset of the exact search filter', () => {
    const page = functionBody('app_private.get_sales_role_lead_workspace_page');
    expect(page).toContain("like ''+91'' || nullif(ltrim($12, ''0''), '''') || ''%''");
    expect(page).toContain("like ''91'' || nullif(ltrim($12, ''0''), '''') || ''%''");
  });
});
