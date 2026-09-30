import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { daysUntil, telecmiPlanSchema } from '../../src/features/integrations/telecmi-plan';

const migration = readFileSync(
  'supabase/migrations/20260929090000_telecmi_agent_directory.sql',
  'utf8',
);
const agentsFunction = readFileSync(
  'supabase/functions/integration-telecmi-agents/index.ts',
  'utf8',
);
const provisioning = readFileSync('supabase/functions/_shared/telecmi-agents.ts', 'utf8');
const adapter = readFileSync('supabase/functions/_shared/telecmi.ts', 'utf8');
const invite = readFileSync('supabase/functions/tenant-user-invite/index.ts', 'utf8');
const connect = readFileSync('supabase/functions/integration-connect-telecmi/index.ts', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

describe('TeleCMI agent directory database contract', () => {
  it('keeps every new function service-role only', () => {
    for (const fn of [
      'get_telecmi_agent_target(uuid, uuid)',
      'get_telecmi_agent_directory(uuid, uuid)',
      'link_telecmi_agent(uuid, uuid, text, text, uuid, uuid, uuid)',
      'set_telecmi_seat_limit(uuid, uuid, integer, uuid, uuid)',
    ]) {
      expect(migration).toContain(`revoke all on function public.${fn}`);
      expect(migration).toContain(`grant execute on function public.${fn}`);
    }
    expect(migration.match(/if auth\.role\(\) <> 'service_role' then/g)?.length).toBe(4);
  });

  it('lets only an active Client Admin change the line', () => {
    expect(migration).toContain("actor_role.role_key = 'client_admin'");
    expect(
      migration.match(/app_private\.telecmi_actor_is_client_admin\(target_actor_id/g)?.length,
    ).toBe(2);
  });

  it('serialises mapping writes and refuses a mobile on two agents', () => {
    expect(migration).toContain('for update;');
    expect(migration).toContain("message = 'TELECMI_AGENT_MAPPING_CONFLICT'");
    expect(migration).toContain("'already_linked', true");
  });

  it('audits agent links and seat changes', () => {
    expect(migration).toContain("'integration.telecmi_agent_linked'");
    expect(migration).toContain("'integration.telecmi_seat_limit_changed'");
  });

  it('only gives agents to active telecallers and sales consultants on a covering line', () => {
    expect(migration).toContain("role_keys && array['telecaller_bdc', 'sales_consultant']");
    expect(migration).toContain("role_row.role_key in ('telecaller_bdc', 'sales_consultant')");
    expect(migration).toContain('app_private.telecmi_connection_covers_branches(');
  });

  it('bounds the recorded seat count', () => {
    expect(migration).toContain('target_seat_limit not between 1 and 1000');
  });
});

describe('TeleCMI agent provisioning', () => {
  it('reuses the agent TeleCMI already has for a mobile before spending a seat', () => {
    const linkExisting = provisioning.indexOf("status: 'LINKED_EXISTING'");
    const seatGuard = provisioning.indexOf("'TELECMI_SEATS_FULL'");
    expect(linkExisting).toBeGreaterThan(-1);
    expect(seatGuard).toBeGreaterThan(linkExisting);
  });

  it('creates on the next free extension within the API range', () => {
    expect(provisioning).toContain('const FIRST_EXTENSION = 101;');
    expect(provisioning).toContain('const LAST_EXTENSION = 999;');
    expect(provisioning).toContain("error.code === 'TELECMI_EXTENSION_TAKEN'");
  });

  it('removes an agent it created but could not link, so no paid seat is orphaned', () => {
    expect(provisioning).toContain(
      'await removeTelecmiUser({ credential, userId: created.userId })',
    );
  });

  it('never returns or stores the generated softphone password', () => {
    expect(provisioning).toContain('password: randomAgentPassword()');
    const resultType = provisioning.slice(
      provisioning.indexOf('export type TelecmiAgentProvisionResult'),
      provisioning.indexOf('};', provisioning.indexOf('export type TelecmiAgentProvisionResult')),
    );
    expect(resultType).not.toContain('password');
    expect(provisioning.match(/password/g)?.length).toBe(2);
  });

  it('walks every page of the TeleCMI agent list and reads balance and expiry', () => {
    expect(adapter).toContain("'/v2/user/list'");
    expect(adapter).toContain('page <= 100');
    expect(adapter).toContain("'/v2/balance'");
    expect(adapter).toContain("'/v2/user/remove'");
  });
});

describe('TeleCMI agents Edge Function', () => {
  it('requires a Client Admin with MFA and connection-level manage permission', () => {
    expect(agentsFunction).toContain("target_permission: 'integration.manage'");
    expect(agentsFunction).toContain("access.role_key !== 'client-admin'");
    expect(agentsFunction).toContain('access.mfa_satisfied !== true');
    expect(config).toContain('[functions.integration-telecmi-agents]\nverify_jwt = true');
  });

  it('reports a TeleCMI outage beside the CRM data instead of failing the card', () => {
    expect(agentsFunction).toContain('Promise.allSettled');
    expect(agentsFunction).toContain('provider_error: providerFailure');
  });
});

describe('automatic agent on invitation', () => {
  it('creates the agent after the user is provisioned and never fails the invite', () => {
    const provisioned = invite.indexOf("admin.rpc('provision_tenant_user'");
    const agent = invite.indexOf('await autoProvisionTelecmiAgent({');
    expect(provisioned).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(provisioned);
    expect(invite).toContain("if (input.actorRoleKey !== 'client-admin')");
    expect(invite).toContain('return success({ ...(result as Record<string, unknown>), telecmi }');
  });

  it('keeps the recorded seat count when the connection form is re-saved', () => {
    expect(connect).toContain(
      '...(previousSeatLimit === null ? {} : { seat_limit: previousSeatLimit })',
    );
  });
});

describe('TeleCMI plan parsing', () => {
  it('parses a plan with an unreachable provider', () => {
    const parsed = telecmiPlanSchema.parse({
      seat_limit: 3,
      seats_used: null,
      seats_left: null,
      balance: null,
      sms_balance: null,
      expires_at: null,
      agents: [],
      users_without_agent: [
        {
          user_id: '395d56ce-7d1b-49ed-a38f-7f97d61300bb',
          full_name: 'Ansar',
          role_key: 'telecaller_bdc',
          phone: '916385275950',
          telecmi_agent_exists: true,
        },
      ],
      provider_error: { code: 'TELECMI_UNREACHABLE', message: 'TeleCMI did not answer.' },
    });
    expect(parsed.users_without_agent[0].telecmi_agent_exists).toBe(true);
  });

  it('counts plan expiry in whole days', () => {
    const now = Date.parse('2026-09-29T06:00:00Z');
    expect(daysUntil('2026-09-29T18:29:59.999Z', now)).toBe(1);
    expect(daysUntil('2026-09-28T18:29:59.999Z', now)).toBe(-1);
    expect(daysUntil('2026-09-27T18:29:59.999Z', now)).toBe(-2);
  });
});
