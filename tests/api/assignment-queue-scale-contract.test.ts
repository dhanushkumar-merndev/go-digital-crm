import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608240009_optimize_assignment_queues.sql');
const leadApi = source('src/features/leads/lead-workspace-api.ts');
const assignmentApi = source('src/features/leads/lead-assignment-workspace-api.ts');
const hardenedAssignment = source(
  'supabase/migrations/202608150001_foundation_security_hardening.sql',
);

function bodyBetween(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const queueBuilder = bodyBetween(
  'create or replace function app_private.build_lead_assignment_workspace(',
  'create or replace function public.get_team_lead_assignment_workspace(',
);
const teamQueue = bodyBetween(
  'create or replace function public.get_team_lead_assignment_workspace(',
  'create or replace function public.get_showroom_lead_assignment_workspace(',
);
const showroomQueue = migration.slice(
  migration.indexOf('create or replace function public.get_showroom_lead_assignment_workspace('),
);

describe('100k-scale lead assignment queue contract', () => {
  it('keeps both public RPC signatures and role-selects the bounded queue', () => {
    expect(
      migration.match(
        /create or replace function public\.get_(?:team|showroom)_lead_assignment_workspace\(/g,
      ),
    ).toHaveLength(2);
    expect(assignmentApi).toContain("'get_team_lead_assignment_workspace'");
    expect(assignmentApi).toContain("'get_showroom_lead_assignment_workspace'");
    expect(queueBuilder).toContain('offset_value > 100000');
    expect(queueBuilder).toContain('target_page_size not in (25, 50, 100)');
  });

  it('binds lead.assign to the same active role assignment and its direct scope', () => {
    expect(teamQueue).toContain("role_row.role_key = 'team_manager'");
    expect(teamQueue).toContain("permission_row.permission_key = 'lead.assign'");
    expect(teamQueue).toContain('assignment_row.active');
    expect(teamQueue).toContain("'ORGANIZATION', 'ALL_BRANCHES', 'OWN_TEAM'");
    expect(teamQueue).toContain('team_row.manager_id = current_user_id');
    expect(teamQueue).toContain('team_row.branch_id = any(assignment_row.selected_branch_ids)');

    expect(showroomQueue).toContain("role_row.role_key = 'showroom_manager'");
    expect(showroomQueue).toContain("permission_row.permission_key = 'lead.assign'");
    expect(showroomQueue).toContain('assignment_row.active');
    expect(showroomQueue).toContain("'ORGANIZATION', 'ALL_BRANCHES'");
    expect(showroomQueue).toContain('branch_row.id = any(assignment_row.selected_branch_ids)');
    expect(showroomQueue).toContain('branch_row.deleted_at is null');
    expect(showroomQueue).toContain('team_row.active');

    expect(migration).not.toContain('app_private.has_permission(');
    expect(migration).not.toContain('app_private.can_access_branch(');
    expect(migration).not.toContain('app_private.can_access_team(');
  });

  it('treats wildcard search literally and never turns non-phone text into a phone match-all', () => {
    expect(queueBuilder).toContain(
      'pg_catalog.replace(\n        normalized_search,\n        pg_catalog.chr(92)',
    );
    expect(queueBuilder).toContain("escape E'\\\\'");
    expect(queueBuilder.match(/search_phone_digits <> ''/g)).toHaveLength(2);
    expect(queueBuilder).not.toContain(
      "normalized_phone ilike '%' || regexp_replace(normalized_search",
    );
  });

  it('counts exactly, pages lean IDs first, then hydrates only bounded PII rows', () => {
    expect(queueBuilder.match(/select count\(\*\)::bigint/g)).toHaveLength(2);
    expect(queueBuilder.match(/with page_ids as materialized \(/g)).toHaveLength(2);
    expect(queueBuilder).toMatch(
      /page_ids as materialized \(\s*select\s+lead_row\.id,\s*lead_row\.team_id,\s*lead_row\.created_at/,
    );
    expect(queueBuilder).toContain('from page_ids page_row\n    join public.leads lead_row');
    expect(queueBuilder).toContain("'total', total_result");
    expect(queueBuilder).toContain("'records', records_result");
    expect(queueBuilder).toContain("'consultants', consultants_result");
    expect(queueBuilder).toContain("'recent_assignments', recent_assignments_result");
  });

  it('pre-aggregates consultant load and limits history IDs before display hydration', () => {
    expect(queueBuilder).toContain('with lead_loads as materialized (');
    expect(queueBuilder).toContain('group by lead_row.team_id, lead_row.assigned_user_id');
    expect(queueBuilder).toContain('left join lead_loads load_row');
    expect(queueBuilder).toContain('with history_ids as materialized (');
    expect(queueBuilder).toContain('limit 25');
    expect(queueBuilder.indexOf('with history_ids as materialized (')).toBeLessThan(
      queueBuilder.lastIndexOf('lead_row.customer_name'),
    );
  });

  it('adds targeted queue/load indexes without replacing the audited mutation boundary', () => {
    expect(migration).toContain('leads_assignment_unassigned_org_oldest_idx');
    expect(migration).toContain('leads_team_unassigned_queue_idx');
    expect(migration).toContain('leads_assignment_phone_trgm_idx');
    expect(migration).toContain('leads_assignment_consultant_load_idx');
    expect(migration).toContain('lead_assignment_history_team_recent_idx');
    expect(migration).not.toContain('create or replace function public.assign_lead(');
    expect(leadApi).toContain(".rpc('assign_lead'");
    expect(hardenedAssignment).toContain("'lead.assigned'");
    expect(hardenedAssignment).toContain("'lead.reassigned'");
    expect(hardenedAssignment).toContain('insert into public.audit_logs');
  });
});
