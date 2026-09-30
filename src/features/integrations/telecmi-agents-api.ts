import { invokeIntegrationFunction } from './integration-workspace-api';
import { telecmiAgentResultSchema, telecmiPlanSchema } from './telecmi-plan';

export {
  daysUntil,
  telecmiPlanSchema,
  type TelecmiAgentResult,
  type TelecmiPlan,
} from './telecmi-plan';

export const telecmiPlanQueryKeyRoot = ['telecmi-plan'] as const;

type ConnectionRef = { organizationId: string; connectionId: string };

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
