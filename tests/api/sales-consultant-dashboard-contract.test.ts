import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608200001_sales_consultant_dashboard.sql',
  'utf8',
);
const topModelsMigration = readFileSync(
  'supabase/migrations/202608200002_sales_consultant_top_models.sql',
  'utf8',
);
const topFiveModelsMigration = readFileSync(
  'supabase/migrations/202608200003_sales_consultant_top_five_models.sql',
  'utf8',
);
const hotPathMigration = readFileSync(
  'supabase/migrations/202608220002_sales_consultant_hot_path_rpcs.sql',
  'utf8',
);
const taskAlertMigration = readFileSync(
  'supabase/migrations/202608240013_sales_consultant_task_alert_count.sql',
  'utf8',
);
const todayScheduleMigration = readFileSync(
  'supabase/migrations/202608250001_sales_consultant_today_schedule.sql',
  'utf8',
);
const scheduleDeepLinksMigration = readFileSync(
  'supabase/migrations/202608260007_schedule_module_deep_links.sql',
  'utf8',
);
const api = readFileSync('src/features/dashboards/sales-consultant-dashboard-api.ts', 'utf8');
const workspace = readFileSync('src/features/dashboards/sales-consultant-dashboard.tsx', 'utf8');
const taskWorkspace = readFileSync('src/features/tasks/task-workspace.tsx', 'utf8');
const dashboardHandler = readFileSync(
  'supabase/functions/sales-consultant-dashboard/index.ts',
  'utf8',
);
const cache = readFileSync('supabase/functions/_shared/workspace-cache.ts', 'utf8');
const aiSummaryHandler = readFileSync(
  'supabase/functions/sales-consultant-ai-summary/index.ts',
  'utf8',
);
const config = readFileSync('supabase/config.toml', 'utf8');

describe('sales consultant dashboard contract', () => {
  it('returns one tenant-scoped dashboard bundle for the current Sales Consultant', () => {
    expect(migration).toContain('get_sales_consultant_dashboard');
    expect(migration).toContain("access_context->>'role_key' <> 'sales-consultant'");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain("'metrics', jsonb_build_object");
    expect(migration).toContain("'schedule'");
    expect(migration).toContain("'pipeline'");
    expect(migration).toContain("'recent_leads'");
  });

  it('derives today from the dealership timezone and never hard-codes a calendar date', () => {
    expect(migration).toContain("target_timezone text default 'Asia/Kolkata'");
    expect(migration).toContain('local_today := timezone(target_timezone, now())::date');
    expect(api).toContain('local_date: z.string()');
    expect(workspace).not.toMatch(/23 May 2025/);
  });

  it('connects model thumbnails to private Tigris inventory files in the dashboard boundary', () => {
    expect(migration).toContain("file_row.resource_type = 'stock_unit'");
    expect(migration).toContain('image_object_file_id');
    expect(api).toContain("functions.invoke('sales-consultant-dashboard'");
    expect(dashboardHandler).toContain('.max(5)');
    expect(dashboardHandler).toContain(".from('object_files')");
    expect(dashboardHandler).toContain('tigrisClient()');
    expect(config).toContain('[functions.sales-consultant-dashboard]\nverify_jwt = true');
  });

  it('returns up to five live top models using scoped bookings, leads and inventory', () => {
    expect(topModelsMigration).toContain('get_sales_consultant_top_models');
    expect(topModelsMigration).toContain('app_private.can_access_record');
    expect(topModelsMigration).toContain('interest_counts');
    expect(topModelsMigration).toContain('current_bookings');
    expect(topModelsMigration).toContain('public.vehicle_models');
    expect(topModelsMigration).toContain('limit 3');
    expect(topFiveModelsMigration).toContain("E'\\n      limit 5\\n'");
    expect(dashboardHandler).not.toContain("client.rpc('get_sales_consultant_top_models'");
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_dashboard_summary'");
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_dashboard_live'");
    expect(workspace).toContain('models.slice(0, 5)');
  });

  it('caches a bounded, scoped dashboard bundle and lets manual refresh rebuild it', () => {
    const summaryFunction = hotPathMigration.slice(
      hotPathMigration.indexOf(
        'create or replace function public.get_sales_consultant_dashboard_summary',
      ),
      hotPathMigration.indexOf(
        'revoke all on function public.get_sales_consultant_dashboard_summary',
      ),
    );
    const summaryShape = dashboardHandler.slice(
      dashboardHandler.indexOf('const dashboardSummaryShape'),
      dashboardHandler.indexOf('const dashboardLiveShape'),
    );
    expect(cache).toContain("'sales-consultant-dashboard'");
    expect(dashboardHandler).toContain('enforceManualRefresh');
    expect(dashboardHandler).toContain("'MANUAL_REFRESH_LIMITED'");
    expect(dashboardHandler).toContain('readWorkspaceCache');
    expect(dashboardHandler).toContain('cache: cachedDashboard.diagnostic');
    expect(api).toContain('cacheDiagnosticSchema');
    expect(api).toContain('cache: envelope.data.cache');
    expect(dashboardHandler).toContain('ttlSeconds: SALES_DASHBOARD_CACHE_TTL_SECONDS');
    expect(dashboardHandler).toContain('client.auth.getClaims(accessToken)');
    expect(dashboardHandler).toContain("client.rpc('get_workspace_bootstrap')");
    expect(dashboardHandler).toContain('user_id: userId');
    expect(dashboardHandler).toContain('organization_id: context.organization_id');
    expect(dashboardHandler).toContain('scope_key: context.scope_key');
    expect(dashboardHandler).not.toContain("target_resource_key: 'tenant-dashboard'");
    expect(summaryShape).not.toContain('schedule');
    expect(summaryShape).not.toContain('recent_leads');
    expect(summaryFunction).not.toContain("'schedule'");
    expect(summaryFunction).not.toContain("'recent_leads'");
    expect(summaryFunction).not.toContain('customer_name');
    expect(summaryFunction).not.toContain('lead_row.phone');
    expect(dashboardHandler.indexOf('const cachedDashboard')).toBeLessThan(
      dashboardHandler.indexOf('const result = await attachInventoryImages'),
    );
    expect(dashboardHandler).toContain('const SALES_DASHBOARD_CACHE_TTL_SECONDS = 24 * 60 * 60');
    expect(dashboardHandler).toContain('forceRefresh: parsed.data.manual_refresh');
  });

  it('keeps dashboard actions connected to the existing CRM workspaces', () => {
    for (const destination of [
      '/sales-consultant/my-leads',
      '/sales-consultant/follow-ups',
      '/sales-consultant/appointments',
      '/sales-consultant/test-drives',
      '/sales-consultant/quotations',
      '/sales-consultant/stock-check',
      '/sales-consultant/bookings',
      '/sales-consultant/tasks',
    ]) {
      expect(workspace).toContain(destination);
    }
  });

  it('orders today’s sales-consultant schedule chronologically across all event types', () => {
    expect(todayScheduleMigration).toContain('get_sales_consultant_dashboard_live');
    expect(todayScheduleMigration).toContain("'Consultant Call'");
    expect(todayScheduleMigration).toContain("when 'Video Call' then 'APPOINTMENT_VIDEO_CALL'");
    expect(todayScheduleMigration).toContain("when 'Test Drive' then 'APPOINTMENT_TEST_DRIVE'");
    expect(todayScheduleMigration).toContain(
      "when 'Consultant Call' then 'APPOINTMENT_CONSULTANT_CALL'",
    );
    expect(todayScheduleMigration).toContain(
      'order by\n        schedule_row.scheduled_at,\n        schedule_row.id)',
    );
    expect(todayScheduleMigration).toContain(
      'order by\n        source_row.scheduled_at,\n        source_row.id\n      limit schedule_item_limit',
    );
    expect(todayScheduleMigration).not.toContain('case schedule_row.kind');
    expect(todayScheduleMigration).not.toContain('case source_row.kind');
    expect(todayScheduleMigration).toContain('schedule_item_limit constant integer := 50');
    expect(todayScheduleMigration).toContain('limit schedule_item_limit');
    expect(todayScheduleMigration).toContain('appointment_row.assigned_user_id = current_user_id');
    expect(todayScheduleMigration).toContain('followup_row.assigned_user_id = current_user_id');
    expect(todayScheduleMigration).toContain('source_row.lead_id');
    expect(todayScheduleMigration).toContain('followup_row.lead_id');
    expect(todayScheduleMigration).toContain('appointment_row.lead_id');
    expect(todayScheduleMigration).toContain('drive_row.lead_id');
    expect(dashboardHandler).toContain('schedule: z.array(z.unknown()).max(50)');
    expect(api).toContain('lead_id: z.uuid().nullable().optional()');
    expect(api).toContain("'APPOINTMENT_VIDEO_CALL'");
    expect(api).toContain("'APPOINTMENT_CONSULTANT_CALL'");
    expect(workspace).toContain('function scheduleItemHref');
    expect(workspace).toContain("item.kind.startsWith('APPOINTMENT_')");
    expect(workspace).toContain("item.kind === 'SHOWROOM_VISIT'");
    expect(workspace).toContain(
      '/sales-consultant/appointments?appointment=${encodeURIComponent(item.id)}',
    );
    expect(workspace).toContain('function followupStatusForSchedule');
    expect(workspace).toContain('function testDriveViewForSchedule');
    expect(workspace).toContain(
      '/sales-consultant/follow-ups?status=${followupStatusForSchedule(item.status)}&q=${encodeURIComponent(item.id)}',
    );
    expect(workspace).toContain(
      '/sales-consultant/test-drives?view=${testDriveViewForSchedule(item.status)}&q=${encodeURIComponent(item.id)}',
    );
    expect(scheduleDeepLinksMigration).toContain('or drive_row.appointment_id = search_uuid');
    expect(scheduleDeepLinksMigration).toContain('or drive_row.lead_id = search_uuid');
    expect(workspace).toContain('const scheduleItems = [...data.schedule].sort');
    expect(workspace).not.toContain('const scheduleGroups');
    expect(workspace).toContain('APPOINTMENT_VIDEO_CALL:');
    expect(workspace).toContain("label: 'Video call'");
    expect(workspace).toContain('APPOINTMENT_CONSULTANT_CALL:');
    expect(workspace).toContain("label: 'Consultant call'");
  });

  it('shows the indexed, permission-bound due-task count instead of a follow-up count', () => {
    expect(taskAlertMigration).toContain('get_sales_consultant_task_due_count');
    expect(taskAlertMigration).toContain("role_row.role_key = 'sales_consultant'");
    expect(taskAlertMigration).toContain("permission_row.permission_key = 'task.view'");
    expect(taskAlertMigration).toContain('task_row.assigned_user_id = current_actor_id');
    expect(taskAlertMigration).toContain("task_row.status in ('OPEN', 'IN_PROGRESS')");
    expect(taskAlertMigration).toContain('task_row.branch_id = any(allowed_branch_ids)');
    expect(taskAlertMigration).not.toContain('task_row.branch_id is null');
    expect(taskAlertMigration).not.toContain('app_private.can_access_record(');
    expect(dashboardHandler).toContain("client.rpc('get_sales_consultant_task_due_count'");
    expect(dashboardHandler).toContain("error?.code === 'PGRST202'");
    expect(dashboardHandler).toContain("client.rpc('get_task_workspace_page'");
    expect(dashboardHandler).toContain("target_status: 'TODAY'");
    expect(dashboardHandler).toContain('response_version: z.literal');
    expect(dashboardHandler).toContain(': summary.alerts');
    expect(dashboardHandler).toContain("{ key: 'TASKS_DUE', value: taskDueCount }");
    expect(api).toContain("'TASKS_DUE'");
    expect(api).toContain('response_version: 2');
    expect(workspace).toContain("label: 'Tasks due today'");
    // Task writes have their own workspace invalidation; the dashboard cache is
    // explicitly replaced only by its user-triggered Refresh control.
    expect(taskWorkspace).toContain("salesConsultantCache.invalidate('task.changed')");
  });

  it('keeps a two-line AI-summary preview and only generates through the cached API on demand', () => {
    expect(workspace).toContain('function AiPipelineSummary');
    expect(workspace).toContain('AI sales summary');
    expect(workspace).toContain('line-clamp-2');
    expect(workspace).toContain('Generate summary');
    expect(workspace).toContain('Regenerate summary');
    expect(workspace).toContain('generateSalesConsultantAiSummary');
    expect(api).toContain("functions.invoke('sales-consultant-ai-summary'");
    expect(aiSummaryHandler).toContain("resource: 'sales-consultant-ai-summary'");
    expect(aiSummaryHandler).toContain('forceRefresh: parsed.data.force_refresh');
    expect(aiSummaryHandler).toContain('ttlSeconds: CACHE_TTL_SECONDS');
    expect(workspace).toContain(
      '<AiPipelineSummary data={data} conversionRate={conversionRate} />',
    );
    expect(workspace).toContain("item.key === 'OVERDUE_FOLLOWUPS'");
  });
});
