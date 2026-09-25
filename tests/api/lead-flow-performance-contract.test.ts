import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const leadOptionMigration = source('supabase/migrations/202609250002_scoped_lead_option_pages.sql');
const accessHelperMigration = source('supabase/migrations/202609250003_plpgsql_access_helpers.sql');
const pdiMigration = source('supabase/migrations/202609250004_pdi_single_save.sql');
const handoffMigration = source('supabase/migrations/202609250005_telecaller_handoff_set.sql');
const customerPagesMigration = source(
  'supabase/migrations/202609250006_customer_pages_resolved_scope.sql',
);
const checklistMigration = source(
  'supabase/migrations/202609250007_delivery_checklist_single_save.sql',
);
const timezoneMigration = source('supabase/migrations/202609250008_fast_timezone_validation.sql');
const leadWorkspace = source('src/features/leads/lead-workspace.tsx');
const dialogPrimitive = source('src/components/ui/dialog.tsx');
const caseDialogs = source('src/features/operations/operational-case-dialogs.tsx');
const caseApi = source('src/features/operations/operational-case-api.ts');
const optionQuery = source('src/lib/query/option-query.ts');
const searchSelect = source('src/components/ui/search-select.tsx');
const pdiDialog = source('src/features/operations/pdi-inspection-dialog.tsx');

describe('lead flow performance contract', () => {
  it('resolves lead-picker scope once instead of calling access helpers per row', () => {
    const helper = leadOptionMigration.slice(
      leadOptionMigration.indexOf('function app_private.scoped_lead_option_page('),
      leadOptionMigration.indexOf('drop function if exists public.get_test_drive_lead_options'),
    );
    expect(helper).toContain('app_private.resolve_permission_record_scope');
    expect(helper).not.toContain('app_private.can_access_record(');
    expect(helper).not.toContain('app_private.can_access_customer(');
    expect(helper).not.toContain('app_private.can_access_lead(');
    // Each scope branch walks its own ordered index and stops at the window.
    expect(helper.match(/limit window_size/g)).toHaveLength(4);
    expect(helper).toContain('offset target_offset');
  });

  it('bounds every lead picker page and keeps each permission gate', () => {
    for (const [rpc, permission] of [
      ['get_test_drive_lead_options', 'test_drive.manage'],
      ['get_quotation_lead_options', 'quotation.manage'],
      ['get_task_lead_options', 'task.create'],
    ]) {
      const body = leadOptionMigration.slice(
        leadOptionMigration.indexOf(`create function public.${rpc}(`),
      );
      expect(body).toContain('target_offset integer default 0');
      expect(body).toContain('target_limit not between 1 and 25');
      expect(body).toContain('target_offset not between 0 and 500');
      expect(body).toContain(`'${permission}'`);
      expect(leadOptionMigration).toContain(
        `revoke all on function public.${rpc}(text, integer, integer) from public, anon;`,
      );
    }
  });

  it('pages dropdowns five rows at a time with a See more control', () => {
    expect(optionQuery).toContain('export const OPTION_PAGE_SIZE = 5;');
    expect(optionQuery).toContain('fetchRows(offset, OPTION_PAGE_SIZE + 1)');
    expect(searchSelect).toContain("'See more'");
  });

  it('converts only non-inlinable access helpers to cached PL/pgSQL plans', () => {
    expect(accessHelperMigration).toContain('(p.prosecdef or p.proconfig is not null)');
    expect(accessHelperMigration).toContain("'can_access_record'");
    expect(accessHelperMigration).toContain("'has_permission'");
    expect(accessHelperMigration).toContain('pg_get_functiondef(fn.oid)');
  });

  it('saves a PDI in one permissioned request and refuses edits after certification', () => {
    expect(pdiMigration).toContain(
      "app_private.has_permission(current_organization_id, 'delivery.manage')",
    );
    expect(pdiMigration).toContain('PDI_ALREADY_CERTIFIED');
    expect(pdiMigration).toContain('PDI_CHECKLIST_INCOMPLETE');
    expect(pdiMigration).toContain('PDI_UNRESOLVED_DEFECTS_REMAIN');
    expect(pdiMigration).toContain('and inspection_id = target_inspection_id');
    expect(pdiMigration).toContain('for update');
    expect(pdiDialog).toContain('savePdiInspection');
    expect(pdiDialog).not.toContain('updatePdiItemResult');
  });

  it('resolves the Telecaller handoff set once per workspace request', () => {
    expect(handoffMigration).toContain('into telecaller_handoff_lead_ids');
    expect(handoffMigration).toContain('lead_row.id = any(telecaller_handoff_lead_ids)');
    expect(handoffMigration).toContain(
      "pg_get_functiondef(\n    'app_private.get_sales_role_lead_workspace_page(",
    );
  });

  it('filters customer pages on scope resolved once, not per customer, lead or booking', () => {
    for (const fn of ['get_customer_workspace_page', 'search_authorized_customers']) {
      const start = customerPagesMigration.indexOf(`create or replace function public.${fn}(`);
      const body = customerPagesMigration.slice(
        start,
        customerPagesMigration.indexOf('$function$;', start),
      );
      expect(body).toContain('app_private.resolve_customer_access_scope(current_organization_id)');
      expect(body).toContain("has_permission(current_organization_id, 'customer.view')");
      expect(body).not.toContain('app_private.can_access_customer(');
      expect(body).not.toContain('app_private.can_access_record(');
      expect(body).not.toContain('app_private.customer_360_visible(');
      expect(body).not.toContain('app_private.has_owned_lead(');
    }
    expect(customerPagesMigration).toContain('language plpgsql');
    expect(customerPagesMigration).not.toContain('language sql');
    expect(customerPagesMigration).toContain(
      'revoke all on function app_private.resolve_customer_access_scope(uuid) from public, anon;',
    );
  });

  it('saves the delivery checklist draft in one guarded, idempotent, audited request', () => {
    expect(checklistMigration).toContain(
      'create or replace function public.save_delivery_checklist(',
    );
    expect(checklistMigration).toContain(
      "operational_case_permission(current_organization_id, 'DELIVERY', 'MANAGE')",
    );
    expect(checklistMigration).toContain('OPERATIONAL_CASE_SCOPE_DENIED');
    expect(checklistMigration).toContain('DELIVERY_CHECKLIST_LOCKED');
    expect(checklistMigration).toContain('DELIVERY_CHECKLIST_VERSION_CONFLICT');
    expect(checklistMigration).toContain('app_private.replay_operational_case_request(');
    expect(checklistMigration).toContain("'case.delivery_checklist.saved'");
    expect(checklistMigration).toContain('and delivery_id = case_row.id');
    expect(checklistMigration).toContain(
      'revoke all on function public.save_delivery_checklist(uuid, jsonb, uuid) from public, anon;',
    );
    expect(caseApi).toContain("rpc('save_delivery_checklist'");
    expect(caseApi).not.toContain("rpc('set_delivery_checklist_item'");
    expect(caseDialogs).toContain('checklistDraft');
    expect(caseDialogs).toContain('Save checklist');
  });

  it('validates timezones from an indexed table instead of reading pg_timezone_names per call', () => {
    expect(timezoneMigration).toContain('create table if not exists app_private.valid_timezones');
    expect(timezoneMigration).toContain(
      'create or replace function app_private.is_valid_timezone(target_timezone text)',
    );
    // Unknown names still fall back to the catalogue, so the accepted set is unchanged.
    expect(timezoneMigration).toContain('from pg_catalog.pg_timezone_names timezone_row where');
    expect(timezoneMigration).toContain(
      "raise exception 'Unrecognised pg_timezone_names check in %'",
    );
    expect(timezoneMigration).toContain('pg_catalog.pg_get_functiondef(function_row.oid)');
  });

  it('changes lead temperature in one press with rollback and refetch', () => {
    const block = leadWorkspace.slice(
      leadWorkspace.indexOf('const temperatureMutation = useMutation({'),
    );
    expect(block).toContain('onMutate: async');
    expect(block).toContain('queryClient.cancelQueries({ queryKey: listKey })');
    expect(block).toContain(
      'context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))',
    );
    expect(block).toContain('onSettled:');
    expect(leadWorkspace).toContain(
      'onSelect={() => onTemperatureChange(row.original, temperature)}',
    );
  });

  it('virtualizes only pages above 50 rows and cancels stale lead requests before refetching', () => {
    expect(leadWorkspace).toContain('const VIRTUALIZE_LEAD_ROWS_ABOVE = 50;');
    expect(leadWorkspace).toContain('enabled: virtualizeRows,');
    expect(leadWorkspace).toContain('!expandedLeadId &&');
    const invalidate = leadWorkspace.slice(
      leadWorkspace.indexOf('const invalidate = useCallback(async () => {'),
    );
    expect(invalidate.indexOf('cancelQueries')).toBeLessThan(
      invalidate.indexOf('invalidateQueries'),
    );
  });

  it('spaces dialog sections evenly and bounds dialog height', () => {
    expect(dialogPrimitive).toContain('gap-4');
    expect(dialogPrimitive).toContain('[&>*]:mt-0');
    expect(dialogPrimitive).toContain('max-h-[calc(100dvh-2rem)]');
  });
  it('looks up the blocking follow-up for one lead instead of paging every follow-up', () => {
    const migration = source('supabase/migrations/202609250009_lead_open_followup_lookup.sql');
    expect(migration).toContain('function public.get_lead_open_followup(target_lead_id uuid)');
    expect(migration).toContain("has_permission(current_organization_id, 'followup.view')");
    expect(migration).toContain('app_private.can_access_lead(target_lead_id)');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain('limit 1');
    expect(migration).toContain('from public, anon;');
    expect(leadWorkspace).toContain('fetchLeadOpenFollowup(lead!.id, signal)');
    expect(leadWorkspace).not.toContain('search: lead!.id');
  });
  it('plans every remaining definer helper once per connection, not per call', () => {
    const migration = source('supabase/migrations/202609250010_plpgsql_remaining_definer_helpers.sql');
    expect(migration).toContain("procedure_row.provolatile = 's'");
    expect(migration).toContain('procedure_row.prosqlbody is null');
    expect(migration).toContain('#variable_conflict use_column');
    expect(migration).toContain("'return query ' || body");
    expect(migration).toContain("raise exception 'Multi-statement SQL body in %'");
    expect(migration).toContain('set plan_cache_mode = force_generic_plan');
    expect(migration).toContain("'resolve_dashboard_record_scope'");
    // List RPCs keep per-call plans so optional filters still pick an index.
    expect(migration).not.toContain("'get_followup_workspace_filtered_page'");
    expect(migration).not.toContain("'operational_case_rows'");
  });
});
