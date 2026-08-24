import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function section(input: string, start: string, end: string) {
  const startIndex = input.indexOf(start);
  const endIndex = input.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return input.slice(startIndex, endIndex);
}

const dashboard = source('supabase/migrations/202608200015_scale_tenant_dashboard_leads.sql');
const work = source('supabase/migrations/202608150016_work_appointments_workspace.sql');
const inbox = source('supabase/migrations/202608220009_shared_inbox_workspace.sql');
const masterData = source('supabase/migrations/202608220029_master_data_workspace.sql');
const operations = source('supabase/migrations/202608150027_operational_case_workspace.sql');
const callProvider = source('supabase/migrations/202608200006_call_manual_recording_upload.sql');
const aiReview = source('supabase/migrations/202608220026_ai_call_field_review_workspace.sql');
const forwardRepair = source(
  'supabase/migrations/202608240002_fix_database_function_lint_errors.sql',
);

describe('fresh migration-chain database function lint repairs', () => {
  it('uses an integer JSON array subscript in the scaled tenant dashboard', () => {
    expect(dashboard).toContain(
      "activity_result -> ((day_row.row_index - 1)::integer) ->> 'value'",
    );
    expect(dashboard).not.toContain("activity_result -> (day_row.row_index - 1) ->> 'value'");
  });

  it('keeps the follow-up parameter distinct from the updated column', () => {
    const completeFollowup = section(
      work,
      'create or replace function public.complete_followup(',
      'create or replace function public.cancel_followup(',
    );
    expect(completeFollowup).toContain('normalized_completion_note text;');
    expect(completeFollowup).toContain('completion_note = normalized_completion_note');
    expect(completeFollowup).not.toContain("completion_note = nullif(btrim(completion_note), ''),");
  });

  it('consumes inbox count and page CTEs in the same SQL statement', () => {
    const conversationPage = section(
      inbox,
      'create or replace function public.get_inbox_conversation_page(',
      'create or replace function public.get_inbox_message_page(',
    );
    expect(conversationPage).toContain('select (select count(*) from filtered), coalesce');
    expect(conversationPage).toContain('into total_rows, rows_data');
    expect(conversationPage).not.toContain('select count(*) into total_rows from filtered;');
  });

  it('defines every master-data timestamp before the workspace reads it', () => {
    for (const table of ['vehicle_brands', 'vehicle_models', 'lead_sources']) {
      expect(masterData).toContain(`alter table public.${table}`);
      expect(masterData).toContain(
        'add column if not exists created_at timestamptz not null default now()',
      );
    }
    expect(masterData).toContain("'created_at', model_row.created_at");
  });

  it('orders delivery checklist items by their existing update timestamp', () => {
    const caseDetail = section(
      operations,
      'create or replace function public.get_operational_case_detail(',
      'create or replace function public.set_delivery_checklist_item(',
    );
    expect(caseDetail).toContain('order by item_row.category, item_row.updated_at, item_row.id');
    expect(caseDetail).not.toContain(
      'order by item_row.category, item_row.created_at, item_row.id',
    );
  });

  it('uses an unambiguous tenant variable for call-provider options', () => {
    const options = section(
      callProvider,
      'create or replace function public.get_call_provider_options(',
      'create or replace function public.create_provider_call_request(',
    );
    expect(options).toContain('current_organization_id uuid;');
    expect(options).toContain('connection_row.organization_id = current_organization_id');
    expect(options).toContain('mapping_row.organization_id = current_organization_id');
    expect(options).not.toContain('where connection_row.organization_id = organization_id');
  });

  it('uses a valid empty PostgreSQL text-array path for AI scalar extraction', () => {
    expect(aiReview).toContain("nullif(resolved_value #>> '{}', '')::public.lead_temperature");
    expect(aiReview).not.toContain("nullif(resolved_value #>> '', '')");
  });
});

describe('already-applied database function lint repair', () => {
  it('repairs all seven installed functions in one transactional migration', () => {
    for (const signature of [
      'app_private.tenant_performance_dashboard(integer,text,boolean)',
      'public.complete_followup(uuid,bigint,text,uuid)',
      'public.get_inbox_conversation_page(text,text,integer,integer)',
      'public.get_master_data_workspace(text,integer,integer,text)',
      'public.get_operational_case_detail(text,uuid)',
      'public.get_call_provider_options(uuid)',
      'public.review_ai_call_fields(uuid,jsonb,uuid)',
    ]) {
      expect(forwardRepair).toContain(`'${signature}'::regprocedure`);
    }
    expect(forwardRepair.trimStart()).toMatch(/^begin;/);
    expect(forwardRepair.trimEnd()).toMatch(/commit;$/);
    expect(forwardRepair).not.toMatch(/drop\s+function/i);
  });

  it('retains the private helper boundary and authenticated RPC grants', () => {
    expect(forwardRepair).toContain(
      'revoke all on function app_private.tenant_performance_dashboard(integer, text, boolean)',
    );
    for (const signature of [
      'public.complete_followup(uuid, bigint, text, uuid)',
      'public.get_inbox_conversation_page(text, text, integer, integer)',
      'public.get_master_data_workspace(text, integer, integer, text)',
      'public.get_operational_case_detail(text, uuid)',
      'public.get_call_provider_options(uuid)',
      'public.review_ai_call_fields(uuid, jsonb, uuid)',
    ]) {
      expect(forwardRepair).toContain(`revoke all on function ${signature}`);
      expect(forwardRepair).toContain(`grant execute on function ${signature}`);
    }
  });
});
