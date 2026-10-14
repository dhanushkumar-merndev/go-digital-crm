import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

// PostgreSQL timestamptz JSON includes offsets such as +00:00, as well as Z.
const timestamp = z.string().datetime({ offset: true });

export const automationEvents = [
  'LEAD_CREATED',
  'LEAD_STAGE_CHANGED',
  'LEAD_TEMPERATURE_CHANGED',
  'TEST_DRIVE_COMPLETED',
  'BOOKING_CONFIRMED',
  'VEHICLE_DELIVERED',
] as const;
export type AutomationEvent = (typeof automationEvents)[number];

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('START_DRIP'), campaign_id: z.uuid() }),
  z.object({
    type: z.literal('NOTIFY_OWNER'),
    title: z.string(),
    message: z.string(),
    include_team_manager: z.boolean(),
  }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

const conditionsSchema = z.object({
  sources: z.array(z.string()).default([]),
  models: z.array(z.string()).default([]),
  temperatures: z.array(z.string()).default([]),
  stages: z.array(z.string()).default([]),
});
export type AutomationConditions = z.infer<typeof conditionsSchema>;

const ruleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  branch_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  event_type: z.enum(automationEvents),
  conditions: conditionsSchema,
  condition_summary: z.string().nullable(),
  actions: z.array(actionSchema),
  action_summary: z.string().nullable(),
  enabled: z.boolean(),
  activated_at: timestamp.nullable(),
  version: z.coerce.number().int().positive(),
  updated_at: timestamp,
  runs_30d: z.coerce.number().int().nonnegative(),
  last_run_at: timestamp.nullable(),
});
export type MarketingAutomationRule = z.infer<typeof ruleSchema>;

const workspaceSchema = z.object({
  organization_id: z.uuid(),
  can_manage: z.boolean(),
  kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    enabled: z.coerce.number().int().nonnegative(),
    runs_today: z.coerce.number().int().nonnegative(),
    drips_started_7d: z.coerce.number().int().nonnegative(),
  }),
  rules: z.array(ruleSchema),
  drip_options: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']),
      branch_id: z.uuid().nullable(),
    }),
  ),
  recent_runs: z.array(
    z.object({
      id: z.uuid(),
      rule_id: z.uuid(),
      rule_name: z.string(),
      status: z.string(),
      event_type: z.string().nullable(),
      customer_name: z.string().nullable(),
      drip_state: z.enum(['REQUESTED', 'CAMPAIGN_NOT_ACTIVE']).nullable(),
      notified: z.boolean(),
      lead_id: z.uuid().nullable(),
      started_at: timestamp,
    }),
  ),
});
export type MarketingAutomationsWorkspace = z.infer<typeof workspaceSchema>;

const mutationSchema = z.object({
  id: z.uuid(),
  enabled: z.boolean(),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export async function fetchMarketingAutomations(signal?: AbortSignal) {
  const request = createClient().rpc('get_marketing_automations_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export type MarketingAutomationInput = {
  name: string;
  description: string | null;
  branchId: string | null;
  eventType: AutomationEvent;
  conditions: AutomationConditions;
  actions: AutomationAction[];
};

/** Creates a rule when `rule` is null; otherwise saves an edit at its version. */
export async function saveMarketingAutomation(
  input: MarketingAutomationInput,
  rule: { id: string; version: number } | null,
  requestId: string,
) {
  const { data, error } = await createClient().rpc('save_marketing_automation', {
    target_rule_id: rule?.id ?? null,
    target_expected_version: rule?.version ?? null,
    target_branch_id: input.branchId,
    target_payload: {
      name: input.name,
      description: input.description,
      event_type: input.eventType,
      conditions: input.conditions,
      actions: input.actions,
    },
    target_request_id: requestId,
  });
  if (error) throw error;
  return mutationSchema.parse(data);
}

export async function setMarketingAutomationState(
  id: string,
  state: 'ENABLED' | 'DISABLED' | 'ARCHIVED',
  version: number,
) {
  const { data, error } = await createClient().rpc('set_marketing_automation_state', {
    target_rule_id: id,
    target_state: state,
    target_expected_version: version,
  });
  if (error) throw error;
  return mutationSchema.parse(data);
}
