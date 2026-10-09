import { normalizeTelecmiPhone, type TelecmiAgent } from './telecmi.ts';

export type TelecmiAgentReservation = { user_id: string; phone: string | null };
export type AvailableTelecmiAgent = {
  agent_id: string;
  name: string | null;
  extension: number | null;
  phone: string;
};

export type ManagedTelecmiAgent = Omit<AvailableTelecmiAgent, 'phone'> & {
  phone: string | null;
  in_use: boolean;
  assignable: boolean;
};

export function telecmiAgentManagementList(
  agents: TelecmiAgent[],
  reservations: TelecmiAgentReservation[],
  appId: number,
): ManagedTelecmiAgent[] {
  const reservedIds = new Set(reservations.map((reservation) => reservation.user_id));
  const reservedPhones = new Set(
    reservations.map((reservation) => mappingPhone(reservation.phone)).filter(Boolean),
  );
  const seen = new Set<string>();
  const result: ManagedTelecmiAgent[] = [];
  for (const agent of agents) {
    if (
      !/^\d{1,12}_\d{1,12}$/.test(agent.agentId) ||
      agent.agentId.split('_')[1] !== String(appId) ||
      seen.has(agent.agentId)
    )
      continue;
    seen.add(agent.agentId);
    const phone = mappingPhone(agent.phone);
    const inUse = reservedIds.has(agent.agentId) || Boolean(phone && reservedPhones.has(phone));
    result.push({
      agent_id: agent.agentId,
      name: agent.name,
      extension: agent.extension,
      phone,
      in_use: inUse,
      assignable: !inUse && phone !== null,
    });
  }
  return result;
}

function mappingPhone(value: string | null) {
  try {
    return normalizeTelecmiPhone(value ?? '');
  } catch {
    return null;
  }
}

export function availableTelecmiAgents(
  agents: TelecmiAgent[],
  reservations: TelecmiAgentReservation[],
  appId: number,
): AvailableTelecmiAgent[] {
  const reservedIds = new Set(reservations.map((reservation) => reservation.user_id));
  const reservedPhones = new Set<string>();
  for (const reservation of reservations) {
    try {
      reservedPhones.add(normalizeTelecmiPhone(reservation.phone ?? ''));
    } catch {
      // A legacy malformed mobile must not make an agent ID available again.
    }
  }
  const seen = new Set<string>();
  const available: AvailableTelecmiAgent[] = [];
  for (const agent of agents) {
    if (
      !/^\d{1,12}_\d{1,12}$/.test(agent.agentId) ||
      agent.agentId.split('_')[1] !== String(appId) ||
      reservedIds.has(agent.agentId) ||
      seen.has(agent.agentId)
    )
      continue;
    let phone: string;
    try {
      phone = normalizeTelecmiPhone(agent.phone ?? '');
    } catch {
      continue;
    }
    if (reservedPhones.has(phone)) continue;
    seen.add(agent.agentId);
    available.push({
      agent_id: agent.agentId,
      name: agent.name,
      extension: agent.extension,
      phone,
    });
  }
  return available;
}
