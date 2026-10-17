import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function fn(sql: string, name: string) {
  const start = sql.indexOf(`create function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end);
}

const migration = source('supabase/migrations/202610141573_auto_call_ivr.sql');
const ivrHandler = source('supabase/functions/provider-ivr-piopiy/index.ts');
const statusWebhook = source('supabase/functions/provider-webhook-piopiy/index.ts');
const dispatch = source('supabase/functions/auto-call-dispatch/index.ts');
const connect = source('supabase/functions/integration-connect-piopiy/index.ts');
const config = source('supabase/config.toml');
const leadRoute = source('src/app/[role]/[[...slug]]/page.tsx');

describe('auto-call IVR database contract', () => {
  it('retires the assignment-based AI voice trigger', () => {
    expect(migration).toContain(
      'drop trigger if exists enqueue_ai_voice_after_round_robin_assignment on public.lead_assignments',
    );
  });

  it('dials only the telecaller’s own uncontacted, non-dormant New leads', () => {
    const claim = fn(migration, 'public.claim_auto_call_jobs');
    expect(claim).toContain("auth.role() <> 'service_role'");
    expect(claim).toContain('candidate.assigned_user_id = dialer_row.user_id');
    expect(claim).toContain("candidate.lifecycle_status = 'New'");
    expect(claim).toContain('candidate.first_contacted_at is null');
    expect(claim).toContain("candidate.temperature is distinct from 'DORMANT'");
    expect(claim).toContain('< dialer_row.max_attempts_per_lead');
    expect(claim).toContain('make_interval(mins => dialer_row.retry_after_minutes)');
    expect(claim).toContain('for update of candidate skip locked');
    expect(claim).toContain('local_now >= settings_row.calling_window_start');
    expect(migration).toContain('auto_call_jobs_one_active_per_user');
  });

  it('never lets a keypress suggest DORMANT or edit the lead directly', () => {
    const fields = fn(migration, 'app_private.auto_ivr_field_value_valid');
    expect(fields).toContain("value #>> '{}' in ('HOT', 'WARM', 'COLD')");
    expect(fields).not.toContain('DORMANT');
    const finalize = fn(migration, 'app_private.finalize_auto_ivr_call_internal');
    expect(finalize).not.toContain('update public.leads');
    expect(finalize).toContain('insert into public.auto_ivr_call_results');
  });

  it('marks a lead contacted only when a key is pressed', () => {
    const answer = fn(migration, 'public.record_auto_ivr_answer');
    expect(answer).toContain('perform app_private.mark_auto_call_contact(call_row.id)');
    expect(answer.indexOf('if option_value is not null then')).toBeLessThan(
      answer.indexOf('perform app_private.mark_auto_call_contact'),
    );
    expect(answer).toContain('on conflict (call_id, node_id, attempt_no) do nothing');
    expect(answer).toContain('connection_id = target_connection_id');
  });

  it('applies answers through the audited lead RPCs and verifies in scope', () => {
    const apply = fn(migration, 'public.apply_auto_call_suggestions');
    expect(apply).toContain("app_private.has_permission(lead_row.organization_id, 'lead.update')");
    expect(apply).toContain('app_private.can_access_record(');
    expect(apply).toContain('perform public.update_lead(');
    expect(apply).toContain('perform public.update_lead_requirements(');
    const verify = fn(migration, 'public.verify_auto_contact');
    expect(verify).toContain('AUTO_CONTACT_NOT_FROM_THIS_CALL');
    expect(verify).toContain("'auto_call.contact_verified'");
  });

  it('versions flows, rejects loops and uses PT409 for conflicts', () => {
    const validator = fn(migration, 'app_private.auto_ivr_definition_error');
    expect(validator).toContain('The questions loop back on themselves');
    expect(validator).toContain('can never be reached');
    expect(migration).toContain("errcode = 'PT409', message = 'AUTO_IVR_FLOW_VERSION_CONFLICT'");
    expect(migration).not.toContain("errcode = '40001'");
    expect(fn(migration, 'public.record_auto_ivr_answer')).toContain(
      'version_row.id = call_row.auto_ivr_flow_version_id',
    );
  });

  it('keeps service RPCs away from browsers and tables behind RLS', () => {
    for (const name of [
      'claim_auto_call_jobs(text, integer)',
      'record_auto_ivr_answer(uuid, uuid, text, text, integer)',
      'finalize_auto_ivr_call(uuid, uuid, text, integer, text)',
      'save_piopiy_connection(',
    ])
      expect(migration).toContain(`revoke all on function public.${name}`);
    for (const table of ['auto_call_jobs', 'auto_ivr_call_answers', 'auto_ivr_flows'])
      expect(migration).toContain(`alter table public.${table} enable row level security`);
  });

  it('patches deployed functions from their live text', () => {
    expect(migration).toContain(
      "pg_get_functiondef('public.authorize_object_action(uuid,uuid,text,uuid,text)'::regprocedure)",
    );
    expect(migration).toContain("''auto_contact_call_id'', auto_contact_call_id");
    expect(migration).toContain('lead workspace anchor % not found exactly once');
  });
});

describe('auto-call IVR edge boundary', () => {
  it('authenticates PIOPIY callbacks with the connection secret', () => {
    for (const handler of [ivrHandler, statusWebhook]) {
      expect(handler).toContain('constantTimeEqual(token, connection.credential.webhook_secret)');
      expect(handler).not.toContain('console.log');
    }
    expect(config).toMatch(/\[functions\.provider-ivr-piopiy]\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.provider-webhook-piopiy]\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.auto-call-dispatch]\nverify_jwt = true/);
  });

  it('lets only the service role dispatch calls', () => {
    expect(dispatch).toContain("claims.role === 'service_role'");
    expect(config).toMatch(/\[functions\.auto-call-dispatch]\nverify_jwt = true/);
  });

  it('stores the PIOPIY token encrypted and never returns it', () => {
    expect(connect).toContain('encryptJson(credential)');
    expect(connect).not.toMatch(/success\(\s*\{[^}]*token/);
    expect(connect).toContain('authorize_telecmi_management_scope');
  });

  it('routes the auto-call result page', () => {
    expect(leadRoute).toContain("slug[2] === 'auto-call'");
    expect(leadRoute).toContain('<AutoIvrFlowBuilder flowId={slug[2]} />');
  });
});
