import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import { readRpc } from '@/lib/supabase/read-rpc';

const ruleSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid().nullable(),
  branch_name: z.string().nullable(),
  max_discount_percent: z.coerce.number().min(0).max(100),
  active: z.boolean(),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
  updated_by_name: z.string().nullable(),
});
export type ApprovalRule = z.infer<typeof ruleSchema>;

const approvalRulesSchema = z.object({
  default_percent: z.coerce.number(),
  can_manage: z.boolean(),
  rules: z.array(ruleSchema),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type ApprovalRules = z.infer<typeof approvalRulesSchema>;

export const approvalRulesKey = ['approval-rules'] as const;

export async function fetchApprovalRules(signal?: AbortSignal): Promise<ApprovalRules> {
  const data = await readRpc(createClient().rpc('get_approval_rules'), signal);
  return approvalRulesSchema.parse(data);
}

export async function saveApprovalRule(input: {
  ruleId: string | null;
  expectedVersion: number | null;
  branchId: string | null;
  maxDiscountPercent: number;
  active: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('save_approval_rule', {
    target_rule_id: input.ruleId,
    expected_version: input.expectedVersion,
    target_branch_id: input.branchId,
    target_max_discount_percent: input.maxDiscountPercent,
    target_active: input.active,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return data;
}

export function approvalRuleErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String((error as { message?: string })?.message ?? '');
  if (message.includes('APPROVAL_RULE_VERSION_CONFLICT'))
    return 'Someone else changed this rule. Close the dialog and try again.';
  if (message.includes('APPROVAL_RULE_ALREADY_EXISTS'))
    return 'That scope already has a rule. Edit the existing one instead.';
  if (message.includes('APPROVAL_RULES_MANAGE_REQUIRED'))
    return 'Only an organization-wide Client Admin can change approval rules.';
  return 'The rule was not saved. Check the limit and try again.';
}
