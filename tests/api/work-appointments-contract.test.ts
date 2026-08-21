import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../supabase/migrations/202608150016_work_appointments_workspace.sql',
    import.meta.url,
  ),
  'utf8',
);
const workspace = readFileSync(
  new URL('../../src/features/work/workspace.tsx', import.meta.url),
  'utf8',
);
const followupCalendarMigration = readFileSync(
  new URL('../../supabase/migrations/202608200005_followup_calendar.sql', import.meta.url),
  'utf8',
);
const followupCalendar = readFileSync(
  new URL('../../src/features/work/followup-calendar.tsx', import.meta.url),
  'utf8',
);
const roleRoute = readFileSync(
  new URL('../../src/app/[role]/[[...slug]]/page.tsx', import.meta.url),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('work-list authorization and query boundary', () => {
  const followups = section(
    'create or replace function public.get_followup_workspace_page(',
    'create or replace function public.get_appointment_workspace_page(',
  );
  const appointments = section(
    'create or replace function public.get_appointment_workspace_page(',
    'create or replace function public.get_work_create_options(',
  );

  it('introduces resource permissions, preset-aware grants, and dedicated RLS', () => {
    for (const permission of [
      'followup.view',
      'followup.create',
      'followup.update',
      'followup.complete',
      'followup.cancel',
      'followup.assign',
      'appointment.view',
      'appointment.create',
      'appointment.update',
      'appointment.complete',
      'appointment.cancel',
      'appointment.assign',
    ])
      expect(migration).toContain(`'${permission}'`);
    expect(migration).toContain('create policy followups_read');
    expect(migration).toContain("app_private.has_permission(organization_id, 'followup.view')");
    expect(migration).toContain('create policy appointments_read');
    expect(migration).toContain("app_private.has_permission(organization_id, 'appointment.view')");
    expect(migration).toContain(
      'revoke insert, update, delete on public.followups from anon, authenticated',
    );
    expect(migration).toContain(
      'revoke insert, update, delete on public.appointments from anon, authenticated',
    );
  });

  it('server-paginates, validates filters/timezone, and enforces tenant/record scope', () => {
    for (const list of [followups, appointments]) {
      expect(list).toContain('AUTHENTICATION_REQUIRED');
      expect(list).toContain('target_page_size not in (25, 50, 100)');
      expect(list).toContain('SEARCH_TOO_LONG');
      expect(list).toContain('INVALID_TIMEZONE');
      expect(list).toContain('app_private.current_tenant_organization()');
      expect(list).toContain('app_private.can_access_record(');
      expect(list).toContain('limit target_page_size');
      expect(list).toContain('offset (target_page - 1) * target_page_size');
      expect(list).toContain('record_row.id asc');
      expect(list).toContain("'kpis', jsonb_build_object(");
      expect(list).toContain("'filters', jsonb_build_object(");
      expect(list).not.toMatch(/select\s+\*\s+from\s+public\.(followups|appointments)/i);
    }
    expect(migration).toContain('followups_org_status_due_page_idx');
    expect(migration).toContain('appointments_org_status_scheduled_page_idx');
  });

  it('returns bounded, scoped create/edit selectors without loading a tenant directory', () => {
    const options = section(
      'create or replace function public.get_work_create_options(',
      'create or replace function app_private.refresh_lead_next_followup(',
    );
    expect(options).toContain("target_kind not in ('followups', 'appointments')");
    expect(options).toContain('app_private.can_access_lead(lead_row.id)');
    expect(options).toContain('app_private.can_access_customer');
    expect(options).toContain('app_private.user_can_receive_work(');
    expect(options).toContain('limit 50');
    expect(options).toContain('limit 100');
  });
});

describe('focused work mutation boundary', () => {
  const functionNames = [
    'create_followup',
    'update_followup',
    'complete_followup',
    'cancel_followup',
    'create_appointment',
    'update_appointment',
    'complete_appointment',
    'cancel_appointment',
  ];

  it('ships one focused, authenticated, RPC-only function for each transition', () => {
    for (const functionName of functionNames) {
      expect(migration).toContain(`create or replace function public.${functionName}(`);
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\(`),
      );
    }
    expect(migration.match(/message = 'AUTHENTICATION_REQUIRED'/g)?.length).toBeGreaterThanOrEqual(
      10,
    );
  });

  it('uses optimistic concurrency and replay-safe idempotency for every update/transition', () => {
    expect(migration).toContain('add column version bigint not null default 1');
    expect(migration.match(/message = 'WORK_VERSION_CONFLICT'/g)?.length).toBe(6);
    expect(migration.match(/app_private\.replay_work_request\(/g)?.length).toBeGreaterThanOrEqual(
      9,
    );
    expect(migration).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("'{replayed}'");
  });

  it('revalidates permissions, assignee scope, allowed patches, and terminal states', () => {
    expect(migration).toContain('app_private.user_can_receive_work(');
    expect(migration).toContain('ASSIGNEE_SCOPE_DENIED');
    expect(migration).toContain('ASSIGN_PERMISSION_REQUIRED');
    expect(migration).toContain('INVALID_FOLLOWUP_PATCH');
    expect(migration).toContain('INVALID_APPOINTMENT_PATCH');
    expect(migration).toContain('FOLLOWUP_TERMINAL');
    expect(migration).toContain('APPOINTMENT_TERMINAL');
    expect(migration).toContain('APPOINTMENT_NOT_DUE');
    expect(migration).toContain('followup.override_complete');
    expect(migration).toContain("'completion_mode', case when manager_override");
  });

  it('audits every mutation and keeps lead next-follow-up/lifecycle state coherent', () => {
    for (const action of [
      'followup.created',
      'followup.updated',
      'followup.completed',
      'followup.cancelled',
      'appointment.created',
      'appointment.updated',
      'appointment.completed',
      'appointment.cancelled',
    ])
      expect(migration).toContain(`'${action}'`);
    expect(migration.match(/insert into public\.audit_logs/g)?.length).toBe(8);
    expect(migration).toContain('app_private.refresh_lead_next_followup');
    expect(migration).toContain('insert into public.lead_stage_history');
    expect(migration).toContain("'Appointment Scheduled'");
  });
});

describe('work web runtime contract', () => {
  it('uses TanStack Query/Table, server pagination, debounce, shadcn, and private Realtime invalidation', () => {
    expect(workspace).toContain('useReactTable');
    expect(workspace).toContain('manualPagination: true');
    expect(workspace).toContain('useDebouncedValue(query.search, 300)');
    expect(workspace).toContain('useTenantRealtimeInvalidation');
    expect(workspace).toContain("resource: 'work'");
    expect(workspace).toContain("from '@/components/ui/table'");
    expect(workspace).not.toMatch(/recharts|chart\.js|apexcharts/i);
  });

  it('wires only completed work families into configured mode', () => {
    expect(roleRoute).toContain("if (spec.category === 'followups' && !isLocalPreviewMode())");
    expect(roleRoute).toContain('<WorkWorkspace kind="followups"');
    expect(roleRoute).toContain("if (spec.category === 'appointments' && !isLocalPreviewMode())");
    expect(roleRoute).toContain('<WorkWorkspace kind="appointments"');
    expect(roleRoute).toContain('if (!isLocalPreviewMode()) return <ProductionDataUnavailable />');
  });
});

describe('follow-up calendar contract', () => {
  it('is month bounded, scope protected, and returns no more than three preview records per day', () => {
    expect(followupCalendarMigration).toContain(
      'create or replace function public.get_followup_calendar(',
    );
    expect(followupCalendarMigration).toContain('FOLLOWUP_MONTH_OUT_OF_RANGE');
    expect(followupCalendarMigration).toContain('app_private.can_access_record(');
    expect(followupCalendarMigration).toContain('app_private.can_access_lead(');
    expect(followupCalendarMigration).toContain('app_private.can_access_customer(');
    expect(followupCalendarMigration).toContain('record_row.day_rank <= 3');
    expect(followupCalendarMigration).toContain('target_day is not null');
    expect(followupCalendarMigration).toContain("'status_counts', jsonb_build_object(");
  });

  it('renders current/next month navigation, three-item overflow, and a right detail sheet', () => {
    expect(followupCalendar).toContain('const [monthOffset, setMonthOffset] = useState<0 | 1>(0)');
    expect(followupCalendar).toContain('const hiddenCount = Math.max(0, (day?.total ?? 0) - 3)');
    expect(followupCalendar).toContain('+{hiddenCount} more');
    expect(followupCalendar).toContain('side="right"');
    expect(followupCalendar).toContain("onAction('complete', record)");
    expect(followupCalendar).toContain("onAction('cancel', record)");
    expect(followupCalendar).toContain('onEdit(record)');
  });
});
