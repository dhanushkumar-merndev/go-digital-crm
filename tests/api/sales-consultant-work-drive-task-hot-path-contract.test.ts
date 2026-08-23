import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/202608220004_sales_consultant_work_drive_task_hot_paths.sql',
  ),
  'utf8',
);
const baseHotPathIndexes = readFileSync(
  join(process.cwd(), 'supabase/migrations/202608220001_sales_consultant_hot_path_indexes.sql'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

const privateSections = {
  followup: section(
    'create or replace function app_private.get_sales_consultant_followup_workspace_page(',
    'revoke all on function app_private.get_sales_consultant_followup_workspace_page(',
  ),
  appointment: section(
    'create or replace function app_private.get_sales_consultant_appointment_workspace_page(',
    'revoke all on function app_private.get_sales_consultant_appointment_workspace_page(',
  ),
  task: section(
    'create or replace function app_private.get_sales_consultant_task_workspace_page(',
    'revoke all on function app_private.get_sales_consultant_task_workspace_page(',
  ),
  testDrive: section(
    'create or replace function app_private.get_sales_consultant_test_drive_workspace_page(',
    'revoke all on function app_private.get_sales_consultant_test_drive_workspace_page(',
  ),
};

const wrapperSections = {
  followup: section(
    'create or replace function public.get_followup_workspace_page(',
    'revoke all on function public.get_followup_workspace_page(',
  ),
  appointment: section(
    'create or replace function public.get_appointment_workspace_page(',
    'revoke all on function public.get_appointment_workspace_page(',
  ),
  task: section(
    'create or replace function public.get_task_workspace_page(',
    'revoke all on function public.get_task_workspace_page(',
  ),
  testDrive: section(
    'create or replace function public.get_test_drive_workspace_page(',
    'revoke all on function public.get_test_drive_workspace_page(',
  ),
  followupCalendar: section(
    'create or replace function public.get_followup_calendar(',
    'revoke all on function public.get_followup_calendar(',
  ),
  appointmentCalendar: section(
    'create or replace function public.get_appointment_calendar(',
    'revoke all on function public.get_appointment_calendar(',
  ),
  appointmentTypeSummary: section(
    'create or replace function public.get_appointment_type_summary(',
    'revoke all on function public.get_appointment_type_summary(',
  ),
};

const calendarSections = {
  followup: section(
    'create or replace function app_private.get_sales_consultant_followup_calendar(',
    'revoke all on function app_private.get_sales_consultant_followup_calendar(',
  ),
  appointment: section(
    'create or replace function app_private.get_sales_consultant_appointment_calendar(',
    'revoke all on function app_private.get_sales_consultant_appointment_calendar(',
  ),
  appointmentTypeSummary: section(
    'create or replace function app_private.get_sales_consultant_appointment_type_summary(',
    'revoke all on function app_private.get_sales_consultant_appointment_type_summary(',
  ),
};

describe('Sales Consultant work/test-drive/task dispatch boundary', () => {
  it('renames and revokes every legacy implementation while preserving public signatures', () => {
    for (const [name, signature] of [
      [
        'get_followup_workspace_page',
        'text, text, text, uuid, uuid, uuid, integer, integer, text, text',
      ],
      [
        'get_appointment_workspace_page',
        'text, text, text, uuid, uuid, uuid, integer, integer, text, text',
      ],
      [
        'get_test_drive_workspace_page',
        'text, text, text, date, date, integer, integer, text, text',
      ],
      ['get_task_workspace_page', 'text, text, text, integer, integer, text, text'],
      ['get_followup_calendar', 'date, date, text, text, text, uuid, uuid, uuid, text'],
      ['get_appointment_calendar', 'date, date, text, text, text, uuid, uuid, uuid, text'],
    ] as const) {
      expect(migration).toContain(
        `alter function public.${name}(\n  ${signature}\n) rename to ${name}_legacy;`,
      );
      expect(migration).toContain(`revoke all on function public.${name}_legacy(`);
      expect(migration).toContain(`grant execute on function public.${name}(`);
    }
    expect(migration).toContain(
      'alter function public.get_appointment_type_summary(text)\n  rename to get_appointment_type_summary_legacy;',
    );
    expect(migration).toContain(
      'revoke all on function public.get_appointment_type_summary_legacy(text)',
    );
    expect(migration).toContain(
      'grant execute on function public.get_appointment_type_summary(text) to authenticated;',
    );
  });

  it('dispatches only Sales Consultant to the hot path and all other roles to legacy', () => {
    const legacyNames = {
      followup: 'get_followup_workspace_page_legacy',
      appointment: 'get_appointment_workspace_page_legacy',
      task: 'get_task_workspace_page_legacy',
      testDrive: 'get_test_drive_workspace_page_legacy',
      followupCalendar: 'get_followup_calendar_legacy',
      appointmentCalendar: 'get_appointment_calendar_legacy',
      appointmentTypeSummary: 'get_appointment_type_summary_legacy',
    } as const;
    for (const [resource, wrapper] of Object.entries(wrapperSections)) {
      expect(wrapper).toContain("access_context->>'role_key' = 'sales-consultant'");
      expect(wrapper).toContain("access_context->>'destination' is distinct from 'CRM'");
      expect(wrapper).toContain("access_context->>'organization_id'");
      expect(wrapper).toContain("access_context->>'user_id'");
      const legacyName = legacyNames[resource as keyof typeof legacyNames];
      expect(wrapper).toContain(`return public.${legacyName}(`);
    }
  });

  it('loads the role permission array exactly once per Sales wrapper', () => {
    for (const wrapper of Object.values(wrapperSections)) {
      expect(wrapper.match(/app_private\.sales_consultant_permissions\(/g)?.length).toBe(1);
      expect(wrapper).not.toContain('app_private.has_permission(');
    }
    for (const wrapper of [
      wrapperSections.followup,
      wrapperSections.appointment,
      wrapperSections.task,
      wrapperSections.testDrive,
      wrapperSections.followupCalendar,
      wrapperSections.appointmentCalendar,
    ]) {
      expect(wrapper).toContain("customer_access := 'customer.view' = any(permission_keys)");
    }
    expect(wrapperSections.followup).toContain("'followup.view' = any(permission_keys)");
    expect(wrapperSections.appointment).toContain("'appointment.view' = any(permission_keys)");
    expect(wrapperSections.task).toContain("'task.view' = any(permission_keys)");
    expect(wrapperSections.testDrive).toContain("'test_drive.view' = any(permission_keys)");
    expect(wrapperSections.testDrive).toContain("'quotation.view' = any(permission_keys)");
    expect(wrapperSections.followupCalendar).toContain("'followup.view' = any(permission_keys)");
    expect(wrapperSections.appointmentCalendar).toContain(
      "'appointment.view' = any(permission_keys)",
    );
    expect(wrapperSections.appointmentTypeSummary).toContain(
      "'appointment.view' = any(permission_keys)",
    );
  });
});

describe('Sales Consultant bounded hot-path query shape', () => {
  it('enforces the exact 25/50/100 page sizes and offsets before display enrichment', () => {
    for (const query of Object.values(privateSections)) {
      expect(query).toContain('target_page_size not in (25, 50, 100)');
      expect(query).toContain('limit target_page_size');
      expect(query).toContain('offset ((target_page - 1)::bigint * target_page_size)');
      expect(query.indexOf('page_ids as materialized')).toBeLessThan(
        query.indexOf('page_rows as materialized'),
      );
      expect(query).toContain('as not materialized');
    }
  });

  it('ships owner-first sort indexes without blocking normal writes', () => {
    for (const indexName of [
      'followups_sc_owner_due_idx',
      'followups_sc_owner_updated_idx',
      'appointments_sc_owner_updated_idx',
      'tasks_sc_owner_due_idx',
      'tasks_sc_owner_updated_idx',
    ]) {
      expect(baseHotPathIndexes).toContain(`create index concurrently if not exists ${indexName}`);
    }
    expect(baseHotPathIndexes).toContain('appointments_sc_owner_scheduled_idx');
    expect(baseHotPathIndexes).toContain('test_drive_appts_sc_owner_scheduled_idx');
    expect(baseHotPathIndexes).not.toMatch(/\bbegin\s*;/i);
    expect(baseHotPathIndexes).not.toMatch(/\bcommit\s*;/i);
    expect(migration.trimStart().startsWith('begin;')).toBe(true);
  });

  it('uses direct tenant, owner, branch and relevant date/status predicates', () => {
    expect(privateSections.followup).toContain(
      'followup_row.organization_id = target_organization_id',
    );
    expect(privateSections.followup).toContain('followup_row.assigned_user_id = target_user_id');
    expect(privateSections.appointment).toContain(
      'appointment_row.assigned_user_id = target_user_id',
    );
    expect(privateSections.task).toContain('task_row.assigned_user_id = target_user_id');
    expect(privateSections.task).toContain('task_row.deleted_at is null');
    expect(privateSections.testDrive).toContain('drive_row.assigned_user_id = target_user_id');
    for (const query of Object.values(privateSections)) {
      expect(query).toContain('branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))');
    }
    expect(privateSections.testDrive).toContain('appointment_row.scheduled_at >= from_at');
    expect(privateSections.testDrive).toContain('appointment_row.scheduled_at < to_exclusive_at');
  });

  it('does not execute access helpers per fact row', () => {
    for (const query of [...Object.values(privateSections), ...Object.values(calendarSections)]) {
      expect(query).not.toMatch(
        /app_private\.(?:has_permission|can_access_record|can_access_customer|can_access_lead|can_access_test_drive)\(/,
      );
    }
  });

  it('keeps customer search on stored indexed names and phones', () => {
    for (const query of [
      privateSections.followup,
      privateSections.appointment,
      privateSections.task,
      privateSections.testDrive,
      calendarSections.followup,
      calendarSections.appointment,
    ]) {
      expect(query).toContain('customer_row.normalized_name');
      expect(query).toContain('customer_row.normalized_phone');
      expect(query).not.toMatch(/normalize_phone_digits\(\s*(?:customer_row|lead_row)\./);
    }
    expect(privateSections.followup).toContain(
      "lower(lead_row.customer_name) ilike '%' || normalized_search || '%'",
    );
    expect(calendarSections.followup).toContain(
      "lower(lead_row.customer_name) ilike '%' || normalized_search || '%'",
    );
  });

  it('batches latest quotation lookup instead of running a correlated query per drive', () => {
    expect(privateSections.testDrive).toContain('latest_quotations as materialized');
    expect(privateSections.testDrive).toContain('select distinct on (drive_row.id)');
    expect(privateSections.testDrive).toContain('quotation_row.assigned_user_id = target_user_id');
    expect(privateSections.testDrive).not.toMatch(/then\s*\(\s*select\s+quotation_row\.status/i);
  });

  it('bounds calendar month cells and scopes type counts with direct date predicates', () => {
    for (const query of [calendarSections.followup, calendarSections.appointment]) {
      expect(query).toContain('day_rank <= 3');
      expect(query).toContain("'month_total'");
      expect(query).toContain("'days'");
      expect(query).toContain("'timezone'");
      expect(query).toContain('assigned_user_id = target_user_id');
      expect(query).toContain('branch_id = any(coalesce(target_branch_ids, array[]::uuid[]))');
    }
    expect(calendarSections.appointment).toContain('appointment_row.scheduled_at >= month_start');
    expect(calendarSections.appointmentTypeSummary).toContain(
      'appointment_row.assigned_user_id = target_user_id',
    );
    for (const key of ['showroom_visit', 'video_call', 'test_drive', 'consultant_call']) {
      expect(calendarSections.appointmentTypeSummary).toContain(`'${key}'`);
    }
  });
});

describe('Sales Consultant response and customer PII contracts', () => {
  it('keeps customer keys but redacts values and PII search without customer.view', () => {
    for (const query of Object.values(privateSections)) {
      expect(query).toContain('target_customer_access');
      expect(query).toContain("'customer_name', page_row.customer_name");
      expect(query).toContain("'phone', page_row.phone");
      expect(query).toMatch(/case when target_customer_access then[\s\S]*?else null end/);
    }
    for (const query of [
      privateSections.followup,
      privateSections.appointment,
      privateSections.testDrive,
      calendarSections.followup,
      calendarSections.appointment,
    ]) {
      expect(query).toContain("else 'Restricted' end");
      expect(query).toMatch(/else null end\s+as phone/);
    }
    expect(privateSections.task).toContain('else null end\n          as customer_name');
  });

  it('preserves follow-up and appointment top-level bundles and filter shapes', () => {
    for (const query of [privateSections.followup, privateSections.appointment]) {
      for (const key of ['records', 'total', 'kpis', 'filters', 'timezone']) {
        expect(query).toContain(`'${key}'`);
      }
      for (const filter of ['branches', 'teams', 'owners']) {
        expect(query).toContain(`'${filter}'`);
      }
    }
    for (const key of ['overdue', 'today', 'upcoming', 'completed_today']) {
      expect(privateSections.followup).toContain(`'${key}'`);
    }
    for (const key of ['today', 'upcoming', 'confirmed', 'completed', 'no_show', 'arrived']) {
      expect(privateSections.appointment).toContain(`'${key}'`);
    }
  });

  it('preserves every paged record key expected by the existing clients', () => {
    const recordKeys = {
      followup: [
        'id',
        'version',
        'lead_id',
        'customer_id',
        'customer_name',
        'phone',
        'interested_model',
        'reason',
        'priority',
        'due_at',
        'display_status',
        'status',
        'assigned_user_id',
        'assigned_user_name',
        'created_by',
        'created_by_name',
        'branch_id',
        'branch_name',
        'team_id',
        'team_name',
        'completed_at',
        'cancelled_at',
        'updated_at',
      ],
      appointment: [
        'id',
        'version',
        'lead_id',
        'customer_id',
        'customer_name',
        'phone',
        'interested_model',
        'appointment_type',
        'scheduled_at',
        'status',
        'attendance_status',
        'notes',
        'assigned_user_id',
        'assigned_user_name',
        'created_by',
        'created_by_name',
        'branch_id',
        'branch_name',
        'team_id',
        'team_name',
        'confirmed_at',
        'arrived_at',
        'completed_at',
        'cancelled_at',
        'updated_at',
      ],
      task: [
        'id',
        'organization_id',
        'branch_id',
        'team_id',
        'lead_id',
        'customer_id',
        'assigned_user_id',
        'title',
        'description',
        'priority',
        'status',
        'due_at',
        'completed_at',
        'completion_note',
        'version',
        'created_at',
        'updated_at',
        'branch_name',
        'team_name',
        'assigned_user_name',
        'customer_name',
        'phone',
        'interested_model',
      ],
      testDrive: [
        'id',
        'organization_id',
        'appointment_id',
        'customer_id',
        'lead_id',
        'branch_id',
        'team_id',
        'assigned_user_id',
        'status',
        'version',
        'scheduled_at',
        'expected_duration_minutes',
        'stock_unit_id',
        'vehicle_registration',
        'start_location',
        'destination',
        'customer_name',
        'phone',
        'branch_name',
        'team_name',
        'assigned_user_name',
        'brand_name',
        'model_name',
        'variant_name',
        'vin',
        'chassis_number',
        'color',
        'started_at',
        'reached_at',
        'completed_at',
        'start_odometer',
        'end_odometer',
        'distance_meters',
        'duration_seconds',
        'start_anchor',
        'reached_anchor',
        'end_anchor',
        'route_finalized_at',
        'route_summary_id',
        'point_count',
        'feedback_id',
        'overall_rating',
        'purchase_intent',
        'cancelled_at',
        'cancellation_reason',
        'updated_at',
        'gps_status',
        'quotation_status',
        'schedule_state',
      ],
    } as const;

    for (const [resource, keys] of Object.entries(recordKeys)) {
      const query = privateSections[resource as keyof typeof privateSections];
      for (const key of keys) {
        expect(query).toContain(`'${key}', page_row.${key}`);
      }
    }
  });

  it('preserves task and test-drive top-level and KPI contracts', () => {
    for (const key of ['records', 'total', 'kpis']) {
      expect(privateSections.task).toContain(`'${key}'`);
    }
    for (const key of ['overdue', 'today', 'upcoming', 'completed_today']) {
      expect(privateSections.task).toContain(`'${key}'`);
    }
    for (const key of ['records', 'total', 'organization_id', 'timezone', 'kpis']) {
      expect(privateSections.testDrive).toContain(`'${key}'`);
    }
    for (const key of [
      'today',
      'overdue',
      'upcoming',
      'active',
      'completed_this_month',
      'cancelled',
      'converted',
    ]) {
      expect(privateSections.testDrive).toContain(`'${key}'`);
    }
  });

  it('preserves calendar response bundles and follow-up status counts', () => {
    for (const query of [calendarSections.followup, calendarSections.appointment]) {
      for (const key of ['month', 'month_total', 'days', 'timezone']) {
        expect(query).toContain(`'${key}'`);
      }
    }
    expect(calendarSections.followup).toContain("'status_counts'");
    for (const key of ['all', 'overdue', 'today', 'upcoming', 'completed', 'cancelled']) {
      expect(calendarSections.followup).toContain(`'${key}'`);
    }
  });
});
