import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610240173_manager_list_scope_once.sql');
const performanceApi = source('src/features/dashboards/team-manager-performance-api.ts');
const performance = source('src/features/dashboards/team-manager-performance.tsx');
const lostSummary = source('src/features/leads/lost-lead-summary.tsx');
const leadWorkspace = source('src/features/leads/lead-workspace.tsx');
const dashboard = source('src/features/dashboards/tenant-dashboard.tsx');

/** The body of one function in the migration, from its header to the next one. */
function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

const legacyLists = [
  ['public.get_appointment_calendar_legacy', "array['appointment.view']"],
  ['public.get_quotation_workspace_page_legacy', "array['quotation.view', 'quotation.manage']"],
  ['public.get_sales_booking_workspace_page_legacy', "array['booking.view', 'booking.manage']"],
  ['public.get_sales_booking_filter_options_legacy', "array['booking.view', 'booking.manage']"],
] as const;

describe('manager list pages resolve scope once', () => {
  it('runs as one transaction of patched deployed definitions', () => {
    expect(migration.trimStart().startsWith('--')).toBe(true);
    expect(migration).toContain('\nbegin;\n');
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
  });

  it.each(legacyLists)('%s filters on a scope resolved once, not per row', (name, keys) => {
    const body = functionBody(name);
    expect(body).toContain('app_private.resolve_permission_record_scope(');
    expect(body).toContain(keys);
    expect(body).not.toContain('app_private.can_access_record(');
    expect(body).toContain('coalesce(record_scope.granted, false)');
    for (const arm of [
      'record_scope.organization_wide',
      'record_scope.branch_scope_ids',
      'record_scope.team_scope_ids',
      'record_scope.own_record_branch_ids',
    ])
      expect(body).toContain(arm);
    // The permission gate still runs before any row is read.
    expect(body).toContain('app_private.has_permission(current_organization_id');
  });

  it('keeps the calendar to the requested month and resolves customer and lead access once', () => {
    const body = functionBody('public.get_appointment_calendar_legacy');
    expect(body).toContain('appointment_row.scheduled_at >= month_start');
    expect(body).toContain('appointment_row.scheduled_at < month_end');
    expect(body).toContain('app_private.resolve_customer_access_scope(current_organization_id)');
    expect(body).not.toContain('app_private.can_access_customer(');
    expect(body).not.toContain('app_private.can_access_lead(');
    expect(body).toContain("array['lead.view']");
    // A deleted lead still hides its appointment, as can_access_lead did.
    expect(body).toContain('lead_row.id is not null');
  });

  it('reads quotation line items for the visible page only', () => {
    const body = functionBody('public.get_quotation_workspace_page_legacy');
    const authorized = body.slice(body.indexOf('with authorized as'), body.indexOf('page_rows as'));
    expect(authorized).not.toContain('public.quotation_items');
    expect(body.slice(body.indexOf('page_rows as'))).toContain('public.quotation_items');
    expect(body).toContain(') limited_row');
  });

  it('counts cancelled bookings for the manager tile', () => {
    expect(functionBody('public.get_sales_booking_workspace_page_legacy')).toContain(
      "'cancelled', (select count(*) from searched_scope where status = 'CANCELLED')",
    );
  });

  it('names each team member role and the connected calls per day', () => {
    const body = functionBody('public.get_team_manager_performance');
    expect(body).toContain("'member_type', member_row.member_type");
    expect(body).toContain("'connected_calls', coalesce(call_row.connected, 0)");
    expect(performanceApi).toContain("member_type: z.enum(['SALES_CONSULTANT', 'TELECALLER_BDC'])");
    expect(performanceApi).toContain(
      'connected_calls: z.coerce.number().int().nonnegative().optional()',
    );
    // A telecaller is never ranked on bookings.
    expect(performance).toContain('!isTelecallerMember(member)');
  });
});

describe('lost lead summary', () => {
  const body = migration.slice(
    migration.indexOf('create or replace function public.get_lost_lead_summary('),
  );

  it('is an authenticated, permission-gated, scope-once aggregate', () => {
    expect(body).toContain("message = 'AUTHENTICATION_REQUIRED'");
    expect(body).toContain("app_private.has_permission(current_organization_id, 'lead.view')");
    expect(body).toContain("message = 'INVALID_TIMEZONE'");
    expect(body).toContain('app_private.resolve_permission_record_scope(');
    expect(body).toContain("lead_row.lifecycle_status = 'Lost'");
    expect(body).toContain('lead_row.deleted_at is null');
    expect(body).not.toContain('can_access_record(');
    expect(body).toContain(
      'revoke all on function public.get_lost_lead_summary(text) from public, anon;',
    );
    expect(body).toContain(
      'grant execute on function public.get_lost_lead_summary(text) to authenticated;',
    );
  });

  it('dates a loss from stage history and returns tiles and reasons in one call', () => {
    expect(body).toContain("history_row.to_status = 'Lost'");
    for (const key of ["'total'", "'this_month'", "'last_7_days'", "'competitor'", "'reasons'"])
      expect(body).toContain(key);
    expect(lostSummary).toContain("rpc('get_lost_lead_summary'");
    expect(leadWorkspace).toContain("slug === 'lost-leads' ? <LostLeadSummary /> : null");
  });
});

describe('manager dashboard pipeline', () => {
  it('draws reached-or-further counts so the funnel always narrows', () => {
    expect(dashboard).toContain('function reachedPipeline(');
    expect(dashboard).toContain('data={pipeline}');
    expect(dashboard).not.toContain('% conversion');
  });
});
