import { createClient } from '@/lib/supabase/client';
import { z } from 'zod';

export type AutomationRule = {
  id: string;
  name: string;
  event_type: string;
  condition_summary: string;
  action_summary: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by_name: string;
  execution_count: number;
  success_rate: number;
};

export type AutomationWorkspace = {
  records: AutomationRule[];
  total: number;
  kpis: {
    total_rules: number;
    active_rules: number;
    draft_rules: number;
    failed_runs_today: number;
  };
  execution_summary: { succeeded: number; failed: number; pending: number };
};

export type AutomationWorkspaceQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  status: 'ALL' | 'ACTIVE' | 'DRAFT';
};

export function normalizeAutomationSearch(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .trim()
    .slice(0, 80);
}

export async function fetchAutomationWorkspace(query: AutomationWorkspaceQuery) {
  const { data, error } = await createClient().rpc('get_automation_rules_workspace', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: normalizeAutomationSearch(query.search) || null,
    target_status: query.status,
  });
  if (error) throw error;
  return data as AutomationWorkspace;
}

export async function createAutomationRule(input: {
  name: string;
  eventType: string;
  conditionSummary: string;
  actionType: string;
  actionSummary: string;
  enabled: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_automation_rule', {
    target_name: input.name,
    target_event_type: input.eventType,
    target_condition_summary: input.conditionSummary,
    target_action_type: input.actionType,
    target_action_summary: input.actionSummary,
    target_enabled: input.enabled,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return data as { id: string; enabled: boolean; replayed: boolean };
}

export async function setAutomationRuleEnabled(ruleId: string, enabled: boolean) {
  const { error } = await createClient().rpc('set_automation_rule_enabled', {
    target_rule_id: ruleId,
    target_enabled: enabled,
  });
  if (error) throw error;
}

const automationRuleDetailSchema = z.object({
  rule: z.object({
    id: z.uuid(),
    name: z.string(),
    event_type: z.string(),
    conditions: z.record(z.string(), z.unknown()),
    actions: z.unknown(),
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    created_by_name: z.string(),
  }),
  statistics: z.object({
    total: z.coerce.number().int().nonnegative(),
    succeeded: z.coerce.number().int().nonnegative(),
    failed: z.coerce.number().int().nonnegative(),
    pending: z.coerce.number().int().nonnegative(),
    last_execution_at: z.string().nullable(),
  }),
  runs: z.array(
    z.object({
      id: z.uuid(),
      status: z.string(),
      result: z.record(z.string(), z.unknown()),
      started_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
});

export type AutomationRuleDetail = z.infer<typeof automationRuleDetailSchema>;

export async function fetchAutomationRuleDetail(ruleId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_automation_rule_detail', { target_rule_id: ruleId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return automationRuleDetailSchema.parse(data);
}
