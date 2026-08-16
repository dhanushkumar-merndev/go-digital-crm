import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  getDefaultLeadStatus,
  getLeadStatusConstraint,
  isLeadVersionConflict,
  LeadVersionConflictError,
  parseLeadQuery,
  toLeadQueryString,
  toPostgrestSearchTerm,
} from '../../src/features/leads/lead-workspace-query';

describe('lead workspace query boundary', () => {
  it('uses bounded server pagination and only recognized URL state', () => {
    const query = parseLeadQuery(
      new URLSearchParams('page=-7&pageSize=77&status=unknown&sort=malicious&q=  Aarav  '),
      'new',
    );
    expect(query).toEqual({
      page: 1,
      pageSize: 25,
      status: 'new',
      sort: 'updated:desc',
      search: 'Aarav',
    });
  });

  it('preserves only meaningful URL query state', () => {
    expect(
      toLeadQueryString({
        page: 2,
        pageSize: 50,
        search: '98765',
        status: 'pending',
        sort: 'customer:asc',
      }),
    ).toBe('page=2&pageSize=50&q=98765&status=pending&sort=customer%3Aasc');
  });

  it('maps lifecycle and derived work-state filters without persisting Pending', () => {
    expect(getLeadStatusConstraint('pending')).toEqual({ column: 'work_state', value: 'PENDING' });
    expect(getLeadStatusConstraint('qualified')).toEqual({
      column: 'lifecycle_status',
      value: 'Qualified',
    });
    expect(getDefaultLeadStatus('new-leads')).toBe('new');
    expect(getDefaultLeadStatus('lost-leads')).toBe('lost');
  });

  it('removes PostgREST OR grammar characters from page-local search input', () => {
    expect(toPostgrestSearchTerm('A,(B)%')).toBe('AB');
  });
});

describe('lead workspace aggregate boundary', () => {
  it('keeps KPI aggregation RLS-invoker and free of a caller-controlled tenant id', () => {
    const migration = readFileSync(
      new URL('../../supabase/migrations/202608150003_lead_workspace_kpis.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('create or replace function public.get_lead_workspace_kpis()');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('from public.leads_with_work_state');
    expect(migration).toContain(
      'grant execute on function public.get_lead_workspace_kpis() to authenticated',
    );
    expect(migration).not.toContain('target_organization_id');
  });

  it('keeps the RLS directory helper executable when profile policies call it', () => {
    const repair = readFileSync(
      new URL(
        '../../supabase/migrations/202608150034_fix_directory_policy_helper_execution.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(repair).toContain(
      'grant execute on function app_private.can_administer_tenant_user(uuid, uuid, text)',
    );
    expect(repair).toContain('to authenticated');
  });

  it('uses one scoped, bounded RPC for the list, count, KPI bundle, and assignee labels', () => {
    const migration = readFileSync(
      new URL(
        '../../supabase/migrations/202608150040_optimize_lead_workspace_page.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const api = readFileSync(
      new URL('../../src/features/leads/lead-workspace-api.ts', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('create or replace function public.get_lead_workspace_page(');
    expect(migration).toContain('with scoped_leads as materialized');
    expect(migration).toContain("'assigned_user_name', assigned_user_name");
    expect(migration).toContain('limit target_page_size');
    expect(api).toContain("supabase.rpc('get_lead_workspace_page'");
    expect(api).not.toContain(".from('leads_with_work_state')");
  });
});

describe('lead update concurrency boundary', () => {
  it('recognizes only the audited optimistic-concurrency conflict signal', () => {
    expect(isLeadVersionConflict(new LeadVersionConflictError())).toBe(true);
    expect(isLeadVersionConflict({ code: '40001', message: 'LEAD_VERSION_CONFLICT' })).toBe(true);
    expect(isLeadVersionConflict({ code: '42501', message: 'PERMISSION_DENIED' })).toBe(false);
    expect(isLeadVersionConflict(new Error('network unavailable'))).toBe(false);
  });
});
