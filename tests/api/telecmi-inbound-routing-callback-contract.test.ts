import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function fn(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end);
}

const migration = source('supabase/migrations/202610141753_inbound_smart_routing_callbacks.sql');
const callFlow = source('supabase/functions/provider-call-flow-telecmi/index.ts');
const connect = source('supabase/functions/integration-connect-telecmi/index.ts');
const settings = source('src/features/integrations/integration-workspace.tsx');
const createLeadDialog = source('src/features/calls/create-lead-from-call-dialog.tsx');
const leadDetail = source('src/features/leads/lead-detail-workspace.tsx');

describe('inbound smart routing', () => {
  it('matches the caller to a lead with the same rule the inbound call log uses', () => {
    const match = fn(migration, 'app_private.telecmi_inbound_lead_match');
    expect(match).toContain("order by (lifecycle_status::text = 'Lost'), created_at desc, id");
    expect(migration).toContain(
      'where id = app_private.telecmi_inbound_lead_match(target_organization_id, caller_lead_phone);',
    );
    expect(fn(migration, 'public.get_telecmi_inbound_route')).toContain(
      'app_private.telecmi_inbound_lead_match(',
    );
  });

  it('is service-role only and rings the owner only when they are a mapped agent', () => {
    const route = fn(migration, 'public.get_telecmi_inbound_route');
    expect(route).toContain("auth.role() <> 'service_role'");
    expect(route).toContain("connection_row.connection_config -> 'parallel_agents'");
    expect(route).toContain('= app_private.telecmi_mapping_phone(owner_phone)');
    expect(migration).toContain(
      'revoke all on function public.get_telecmi_inbound_route(uuid, text) from public, anon, authenticated;',
    );
    expect(migration).toContain(
      'grant execute on function public.get_telecmi_inbound_route(uuid, text) to service_role;',
    );
  });

  it('asks for the owner before the configured action and falls through on any miss', () => {
    const lookup = callFlow.indexOf("admin.rpc('get_telecmi_inbound_route'");
    const ivr = callFlow.indexOf("config.inbound_route === 'IVR'");
    expect(lookup).toBeGreaterThan(0);
    expect(lookup).toBeLessThan(ivr);
    expect(callFlow).toContain('config.known_caller_routing !== false');
    expect(callFlow).toContain('if (!routeError && owner?.agent_id && owner.phone)');
    expect(callFlow).toContain('welcome_music: config.inbound_greeting_file');
  });

  it('lets the Client Admin switch it off and set a greeting file', () => {
    expect(connect).toContain('known_caller_routing: z.boolean().default(true)');
    expect(connect).toContain('inbound_greeting_file: input.inbound_greeting_file || null');
    expect(settings).toContain('name="inboundGreetingFile"');
    expect(settings).toContain('onCheckedChange={setKnownCallerRouting}');
  });
});

describe('missed-call callback follow-up', () => {
  it('keeps one open callback per number', () => {
    expect(migration).toContain(
      'create unique index if not exists followups_open_callback_phone_uidx',
    );
    expect(migration).toContain(
      "where callback_phone is not null and status in ('OPEN', 'OVERDUE');",
    );
    const open = fn(migration, 'app_private.open_missed_call_callback');
    expect(open).toContain("'Customer Callback', due, 'OPEN',");
    expect(open).toContain('on conflict (organization_id, callback_phone)');
    expect(open).toContain('due_at = least(public.followups.due_at, excluded.due_at)');
    expect(open).toContain("'followup.callback_created_from_missed_call'");
  });

  it('opens on a settled missed inbound call without blocking the call log', () => {
    expect(migration).toContain(
      "if changed and call_row.status = ''FAILED'' and call_row.outcome = ''NO_ANSWER'' then",
    );
    expect(migration).toContain('perform app_private.open_missed_call_callback(call_row.id);');
    expect(migration).toContain("''followup.callback_skipped''");
  });

  it('completes once the number is reached, in or out', () => {
    const complete = fn(migration, 'app_private.complete_callback_followups');
    expect(complete).toContain("status = 'COMPLETED'");
    expect(complete).toContain('completed_at = now()');
    expect(complete).toContain("'followup.callback_completion_skipped'");
    expect(migration).toContain("elsif changed and call_row.outcome = ''CONNECTED'' then");
    expect(migration).toContain('if became_connected and call_row.lead_id is not null then');
    expect(migration).toContain(
      '(select normalized_phone from public.leads where id = call_row.lead_id),',
    );
  });

  it('shows a lead-less callback by its number in every follow-up list', () => {
    for (const name of [
      'get_followup_workspace_page_legacy',
      'get_followup_workspace_filtered_page',
      'get_scoped_followup_workspace_filtered_page',
      'get_telecaller_followup_workspace_filtered_page',
      'get_sales_consultant_followup_workspace_filtered_page',
      'get_sales_consultant_followup_workspace_page',
    ])
      expect(migration).toContain(name);
    expect(migration).toContain("then ''Missed call'' end,");
  });
});

describe('create lead from an inbound call', () => {
  it('opens the possible-customer review instead of merging by phone', () => {
    expect(createLeadDialog).toContain(
      'router.push(`${leadDetailHref(role, result.lead_id)}?match=customer`);',
    );
    expect(leadDetail).toContain("searchParams.get('match') === 'customer'");
    expect(leadDetail).toContain('!lead.customer_id &&');
    expect(leadDetail).toContain("hasWorkspacePermission(workspaceSession, 'customer.link');");
  });
});
