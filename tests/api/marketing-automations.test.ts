import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));
import { roleNavigation } from '../../src/config/navigation';
import {
  fetchMarketingAutomations,
  saveMarketingAutomation,
  setMarketingAutomationState,
} from '../../src/features/marketing/marketing-rules-api';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const migration = source('supabase/migrations/202610141371_marketing_automations.sql');
const route = source('src/app/[role]/[[...slug]]/page.tsx');
const sidebar = source('src/components/shared/app-sidebar.tsx');
const id = '65d2a775-8b6d-45f6-a031-52b0be7b1125';
const now = '2026-10-14T05:30:00.000+00:00';

describe('Campaigns sub-menu', () => {
  it('folds ad, drip and automation pages under one Campaigns parent', () => {
    const grouped = roleNavigation['digital-marketing'].items.filter(
      (item) => item.group?.title === 'Campaigns',
    );
    expect(grouped.map((item) => item.slug)).toEqual([
      'campaigns',
      'drip-campaigns',
      'automations',
    ]);
    expect(sidebar).toContain('navigationEntries(navigationItems)');
  });

  it('keeps every grouped page routable, so no sub-item dead-ends', () => {
    expect(route).toContain("slug[0] === 'automations'");
    expect(route).toContain('<MarketingRulesWorkspace spec={spec} />');
    expect(route).toContain("['drip-campaigns', 'reviews'].includes(slug[0])");
    expect(route).toContain("'campaigns'");
  });
});

describe('marketing automations API', () => {
  beforeEach(() => rpc.mockReset());

  it('parses the workspace bundle', async () => {
    const data = {
      organization_id: id,
      can_manage: true,
      kpis: { total: 1, enabled: 1, runs_today: 2, drips_started_7d: 1 },
      rules: [
        {
          id,
          name: 'Hot lead alert',
          description: null,
          branch_id: id,
          branch_name: 'MG Road',
          event_type: 'LEAD_TEMPERATURE_CHANGED',
          conditions: { sources: [], models: [], temperatures: ['HOT'], stages: [] },
          condition_summary: 'Lead temperature changes: temperature HOT',
          actions: [
            { type: 'START_DRIP', campaign_id: id },
            {
              type: 'NOTIFY_OWNER',
              title: 'Hot lead',
              message: 'Call now',
              include_team_manager: true,
            },
          ],
          action_summary: 'Start drip "Hot" and notify the lead owner and team manager',
          enabled: true,
          activated_at: now,
          version: 3,
          updated_at: now,
          runs_30d: 4,
          last_run_at: now,
        },
      ],
      drip_options: [{ id, name: 'Hot', status: 'ACTIVE', branch_id: null }],
      recent_runs: [
        {
          id,
          rule_id: id,
          rule_name: 'Hot lead alert',
          status: 'COMPLETED',
          event_type: 'LEAD_TEMPERATURE_CHANGED',
          customer_name: 'Asha',
          drip_state: 'REQUESTED',
          notified: true,
          lead_id: id,
          started_at: now,
        },
      ],
    };
    rpc.mockResolvedValue({ data, error: null });
    await expect(fetchMarketingAutomations()).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledWith('get_marketing_automations_workspace');
  });

  it('creates without an id or version and edits at the expected version', async () => {
    rpc.mockResolvedValue({
      data: { id, enabled: false, version: 1, replayed: false },
      error: null,
    });
    const input = {
      name: 'Qualified alert',
      description: null,
      branchId: id,
      eventType: 'LEAD_STAGE_CHANGED' as const,
      conditions: { sources: [], models: [], temperatures: [], stages: ['Qualified'] },
      actions: [
        {
          type: 'NOTIFY_OWNER' as const,
          title: 'Qualified',
          message: 'Book a test drive',
          include_team_manager: false,
        },
      ],
    };
    await saveMarketingAutomation(input, null, id);
    expect(rpc).toHaveBeenLastCalledWith(
      'save_marketing_automation',
      expect.objectContaining({ target_rule_id: null, target_expected_version: null }),
    );
    await saveMarketingAutomation(input, { id, version: 4 }, id);
    expect(rpc).toHaveBeenLastCalledWith('save_marketing_automation', {
      target_rule_id: id,
      target_expected_version: 4,
      target_branch_id: id,
      target_request_id: id,
      target_payload: {
        name: input.name,
        description: null,
        event_type: 'LEAD_STAGE_CHANGED',
        conditions: input.conditions,
        actions: input.actions,
      },
    });
  });

  it('preserves the refusal to switch on a rule whose drip is not running', async () => {
    const error = { code: '22023', message: 'AUTOMATION_DRIP_NOT_ACTIVE' };
    rpc.mockResolvedValue({ data: null, error });
    await expect(setMarketingAutomationState(id, 'ENABLED', 2)).rejects.toEqual(error);
    expect(rpc).toHaveBeenCalledWith('set_marketing_automation_state', {
      target_rule_id: id,
      target_state: 'ENABLED',
      target_expected_version: 2,
    });
  });
});

describe('marketing automation runner contract', () => {
  it('acts on each event once and never replays events before switching on', () => {
    expect(migration).toContain('on public.automation_runs (rule_id, occurrence_key)');
    expect(migration).toContain(
      'on conflict (rule_id, occurrence_key) where occurrence_key is not null do nothing',
    );
    expect(migration).toContain("greatest(rule_row.activated_at, pass_at - interval '3 days')");
  });

  it('sends drips through the drip pass, so DORMANT and opt-outs still apply', () => {
    expect(migration).toContain('union all select * from automation_match');
    expect(migration).toContain("where campaign.trigger_type = ''AUTOMATION''");
    expect(migration).not.toMatch(/insert into public\.customer_drip_messages/);
  });

  it('runs inside the per-minute drip pass and cannot stop it', () => {
    expect(migration).toContain(
      'automation_outcome := public.run_marketing_automations(target_limit);',
    );
    expect(migration).toContain("automation_outcome := jsonb_build_object(''failed''");
  });

  it('refuses to switch on a rule whose drip is not active, and keeps admin rules apart', () => {
    expect(migration).toContain("message = 'AUTOMATION_DRIP_NOT_ACTIVE'");
    expect(migration).toContain("rule_row.module = ''ADMIN''");
    expect(migration).toContain(
      'revoke all on function public.run_marketing_automations(integer) from public, anon, authenticated;',
    );
  });

  it('notifies only recipients allowed to see the lead, once per event', () => {
    expect(migration).toContain("recipient_row.user_id, 'lead.view')");
    expect(migration).toContain(
      'on conflict (organization_id, user_id, dedupe_key) where dedupe_key is not null do nothing',
    );
  });
});
