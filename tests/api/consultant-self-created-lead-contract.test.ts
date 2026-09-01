import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202609010001_consultant_self_created_lead_assignment.sql',
  'utf8',
);

describe('Sales Consultant self-created lead', () => {
  it('lets the creator own the lead they just entered', () => {
    expect(migration).toContain(
      'create or replace function app_private.enforce_sales_lead_assignment()',
    );
    expect(migration).toContain("current_setting('app.create_lead_rpc', true), '') = 'on'");
    expect(migration).toContain('new.assigned_user_id = auth.uid()');
    expect(migration).toContain('new.assigned_by = auth.uid()');
    expect(migration).toContain('if actor_created_own_lead then\n    return new;');
  });

  it('keeps every other assignment under the same role rules', () => {
    expect(migration).toContain('SALES_CONSULTANT_CANNOT_ASSIGN_LEADS');
    expect(migration).toContain('SALES_HANDOFF_REQUIRES_QUALIFIED_LEAD');
    expect(migration).toContain('FRESH_ASSIGNMENT_REQUIRES_TELECALLER');
  });

  it('names the server-side reasons a creation can still fail for', () => {
    expect(workspace).toContain('SALES_CONSULTANT_CANNOT_ASSIGN_LEADS:');
    expect(workspace).toContain('FRESH_ASSIGNMENT_REQUIRES_TELECALLER:');
    expect(workspace).toContain('SCOPE_DENIED:');
    expect(workspace).toContain('LEAD_FIELD_TOO_LONG:');
  });
});
