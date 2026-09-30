import { z } from 'zod';

/*
 * TeleCMI plan shapes, kept free of client imports so the parsing rules stay
 * unit-testable (same split as src/features/calls/live-call-status.ts).
 */

const nullableNumber = z.number().nullable();

export const telecmiPlanSchema = z.object({
  seat_limit: nullableNumber,
  seats_used: nullableNumber,
  seats_left: nullableNumber,
  balance: nullableNumber,
  sms_balance: nullableNumber,
  expires_at: z.string().nullable(),
  agents: z.array(
    z.object({
      agent_id: z.string(),
      name: z.string().nullable(),
      extension: nullableNumber,
      phone: z.string().nullable(),
      crm_user_id: z.string().nullable(),
      crm_user_name: z.string().nullable(),
      linked: z.boolean(),
    }),
  ),
  users_without_agent: z.array(
    z.object({
      user_id: z.string(),
      full_name: z.string(),
      role_key: z.string(),
      phone: z.string().nullable(),
      telecmi_agent_exists: z.boolean(),
    }),
  ),
  provider_error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export type TelecmiPlan = z.infer<typeof telecmiPlanSchema>;

export const telecmiAgentResultSchema = z.object({
  status: z.enum(['CREATED', 'LINKED_EXISTING', 'ALREADY_LINKED']),
  agent_user_id: z.string(),
  extension: nullableNumber,
  connection_id: z.string(),
});

export type TelecmiAgentResult = z.infer<typeof telecmiAgentResultSchema>;

/**
 * Whole days until the plan expires: rounded up while it is still valid, so a
 * plan ending tonight reads 1; negative as soon as it has lapsed, so a plan
 * that ended an hour ago reads -1 rather than "expires today".
 */
export function daysUntil(isoDate: string, now = Date.now()) {
  const remaining = (new Date(isoDate).getTime() - now) / 86_400_000;
  return remaining < 0 ? Math.floor(remaining) : Math.ceil(remaining);
}
