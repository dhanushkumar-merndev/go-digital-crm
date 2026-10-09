import { invokeIntegrationFunction } from './integration-workspace-api';
import { telecmiAgentResultSchema, telecmiPlanSchema } from './telecmi-plan';
import { z } from 'zod';
import type { IntegrationScopeMode } from './integration-workspace-api';

export {
  daysUntil,
  telecmiPlanSchema,
  type TelecmiAgentResult,
  type TelecmiPlan,
} from './telecmi-plan';

export const telecmiPlanQueryKeyRoot = ['telecmi-plan'] as const;

type ConnectionRef = { organizationId: string; connectionId: string };

const availableAgentsSchema = z.object({
  all_agents: z.array(
    z.object({
      agent_id: z.string().regex(/^\d{1,12}_\d{1,12}$/),
      name: z.string().nullable(),
      extension: z.number().nullable(),
      phone: z.string().nullable(),
      in_use: z.boolean(),
      assignable: z.boolean(),
    }),
  ),
  agents: z.array(
    z.object({
      agent_id: z.string().regex(/^\d{1,12}_\d{1,12}$/),
      name: z.string().nullable(),
      extension: z.number().nullable(),
      phone: z.string().regex(/^[1-9]\d{7,14}$/),
    }),
  ),
});

export async function fetchAvailableTelecmiAgents(input: {
  organizationId: string;
  connectionId?: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  appId: number;
  appSecret?: string;
}) {
  const data = await invokeIntegrationFunction<unknown>('integration-telecmi-list-agents', {
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    scope_mode: input.scopeMode,
    branch_ids: input.branchIds,
    app_id: input.appId,
    app_secret: input.appSecret || undefined,
  });
  return availableAgentsSchema.parse(data);
}

export type ManagedTelecmiAgent = z.infer<typeof availableAgentsSchema>['all_agents'][number];

export function removeTelecmiAgent(input: {
  organizationId: string;
  connectionId?: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  appId: number;
  appSecret?: string;
  agentId: string;
  requestId: string;
}) {
  return invokeIntegrationFunction<{ removed: boolean; agent_id: string }>(
    'integration-telecmi-remove-agent',
    {
      organization_id: input.organizationId,
      connection_id: input.connectionId,
      scope_mode: input.scopeMode,
      branch_ids: input.branchIds,
      app_id: input.appId,
      app_secret: input.appSecret || undefined,
      agent_id: input.agentId,
      request_id: input.requestId,
    },
  );
}

export async function fetchTelecmiPlan(input: ConnectionRef) {
  const data = await invokeIntegrationFunction<unknown>('integration-telecmi-agents', {
    action: 'status',
    organization_id: input.organizationId,
    connection_id: input.connectionId,
  });
  return telecmiPlanSchema.parse(data);
}

export async function createTelecmiAgentForUser(input: ConnectionRef & { userId: string }) {
  const data = await invokeIntegrationFunction<unknown>('integration-telecmi-agents', {
    action: 'provision',
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    user_id: input.userId,
  });
  return telecmiAgentResultSchema.parse(data);
}

export function setTelecmiSeatLimit(input: ConnectionRef & { seatLimit: number | null }) {
  return invokeIntegrationFunction<{ seat_limit: number | null }>('integration-telecmi-agents', {
    action: 'set_seat_limit',
    organization_id: input.organizationId,
    connection_id: input.connectionId,
    seat_limit: input.seatLimit,
  });
}
