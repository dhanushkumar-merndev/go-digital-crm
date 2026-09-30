import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { decryptJson } from './crypto.ts';
import {
  addTelecmiUser,
  listTelecmiAgents,
  normalizeTelecmiPhone,
  removeTelecmiUser,
  TelecmiError,
  type TelecmiAgent,
  type TelecmiCredential,
} from './telecmi.ts';

// TeleCMI's /v2/user/add only accepts extensions up to 999.
const FIRST_EXTENSION = 101;
const LAST_EXTENSION = 999;
const EXTENSION_ATTEMPTS = 5;

export type TelecmiAgentTarget = {
  user_id: string;
  full_name: string;
  phone: string | null;
  active: boolean;
  eligible: boolean;
  role_keys: string[];
  connection_id: string | null;
};

export type TelecmiAgentDirectory = {
  seat_limit: number | null;
  mapped_agents: Array<{ user_id?: string; phone?: string; crm_user_id?: string }>;
  candidates: Array<{ user_id: string; full_name: string; phone: string | null; role_key: string }>;
};

export type TelecmiAgentProvisionResult = {
  status: 'CREATED' | 'LINKED_EXISTING' | 'ALREADY_LINKED';
  agent_user_id: string;
  extension: number | null;
  connection_id: string;
};

// A refusal the CRM decides on its own, before or instead of asking TeleCMI.
export class TelecmiAgentProvisionError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'TelecmiAgentProvisionError';
  }
}

export function phoneDigits(value: string | null | undefined) {
  if (!value) return null;
  try {
    return normalizeTelecmiPhone(value);
  } catch {
    return null;
  }
}

export async function loadTelecmiCredential(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
) {
  const { data, error } = await admin
    .from('integration_credentials')
    .select('encrypted_payload')
    .eq('organization_id', organizationId)
    .eq('connected_account_id', connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new TelecmiAgentProvisionError(
      'TELECMI_CREDENTIAL_NOT_CONFIGURED',
      'The stored TeleCMI credential for this line is missing. Reconnect TeleCMI.',
      409,
    );
  return decryptJson<TelecmiCredential>(data.encrypted_payload);
}

export async function getTelecmiAgentDirectory(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
) {
  const { data, error } = await admin.rpc('get_telecmi_agent_directory', {
    target_organization_id: organizationId,
    target_connection_id: connectionId,
  });
  if (error) throw error;
  return data as TelecmiAgentDirectory;
}

function randomAgentPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function freeExtensions(agents: TelecmiAgent[]) {
  const used = new Set(agents.map((agent) => agent.extension).filter((value) => value !== null));
  const free: number[] = [];
  for (let extension = FIRST_EXTENSION; extension <= LAST_EXTENSION; extension += 1)
    if (!used.has(extension)) free.push(extension);
  return free;
}

async function linkAgent(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    connectionId: string;
    agentUserId: string;
    phone: string;
    userId: string;
    actorId: string;
    requestId: string;
  },
) {
  const { error } = await admin.rpc('link_telecmi_agent', {
    target_organization_id: input.organizationId,
    target_connection_id: input.connectionId,
    target_agent_user_id: input.agentUserId,
    target_agent_phone: input.phone,
    target_crm_user_id: input.userId,
    target_actor_id: input.actorId,
    target_request_id: input.requestId,
  });
  if (!error) return;
  if (error.message === 'CLIENT_ADMIN_REQUIRED')
    throw new TelecmiAgentProvisionError(
      'CLIENT_ADMIN_REQUIRED',
      'Only a Client Admin can create TeleCMI agents.',
      403,
    );
  if (error.message === 'TELECMI_AGENT_MAPPING_CONFLICT')
    throw new TelecmiAgentProvisionError(
      'TELECMI_AGENT_MAPPING_CONFLICT',
      'This mobile or agent is already linked to someone else on this line.',
      409,
    );
  throw error;
}

/**
 * Gives one CRM user a working TeleCMI agent: links the agent TeleCMI already
 * has for their mobile, or creates one on the next free extension. The
 * softphone password is generated and never stored or returned -- a
 * follow-me line rings the mobile and does not need it.
 */
export async function provisionTelecmiAgentForUser(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    actorId: string;
    requestId: string;
    connectionId?: string;
  },
): Promise<TelecmiAgentProvisionResult> {
  const { data: rawTarget, error: targetError } = await admin.rpc('get_telecmi_agent_target', {
    target_organization_id: input.organizationId,
    target_user_id: input.userId,
  });
  if (targetError) throw targetError;
  const target = rawTarget as TelecmiAgentTarget | null;
  if (!target)
    throw new TelecmiAgentProvisionError('USER_NOT_FOUND', 'The user no longer exists.', 404);
  if (!target.eligible)
    throw new TelecmiAgentProvisionError(
      'TELECMI_AGENT_ROLE_NOT_ELIGIBLE',
      'Only active telecallers and sales consultants get a TeleCMI agent.',
      422,
    );
  const phone = phoneDigits(target.phone);
  if (!phone)
    throw new TelecmiAgentProvisionError(
      'TELECMI_AGENT_PHONE_MISSING',
      'Add a valid mobile number to this user first; TeleCMI rings that number.',
      422,
    );
  const connectionId = input.connectionId ?? target.connection_id;
  if (!connectionId)
    throw new TelecmiAgentProvisionError(
      'TELECMI_LINE_NOT_AVAILABLE',
      "No connected TeleCMI line covers this user's branch.",
      409,
    );

  const directory = await getTelecmiAgentDirectory(admin, input.organizationId, connectionId);
  if (!directory.candidates.some((candidate) => candidate.user_id === input.userId))
    throw new TelecmiAgentProvisionError(
      'TELECMI_LINE_SCOPE_MISMATCH',
      "This TeleCMI line does not cover the user's branch.",
      409,
    );
  const mapped = directory.mapped_agents.find((agent) => phoneDigits(agent.phone) === phone);
  if (mapped?.user_id)
    return {
      status: 'ALREADY_LINKED',
      agent_user_id: mapped.user_id,
      extension: null,
      connection_id: connectionId,
    };

  const credential = await loadTelecmiCredential(admin, input.organizationId, connectionId);
  const agents = await listTelecmiAgents(credential);
  const existing = agents.find((agent) => phoneDigits(agent.phone) === phone);
  if (existing) {
    await linkAgent(admin, { ...input, connectionId, agentUserId: existing.agentId, phone });
    return {
      status: 'LINKED_EXISTING',
      agent_user_id: existing.agentId,
      extension: existing.extension,
      connection_id: connectionId,
    };
  }

  if (directory.seat_limit !== null && agents.length >= directory.seat_limit)
    throw new TelecmiAgentProvisionError(
      'TELECMI_SEATS_FULL',
      `All ${directory.seat_limit} TeleCMI agent seats are in use. Free a seat or raise the plan before adding this user.`,
      409,
    );

  const candidates = freeExtensions(agents);
  if (!candidates.length)
    throw new TelecmiAgentProvisionError(
      'TELECMI_NO_FREE_EXTENSION',
      'Every TeleCMI extension from 101 to 999 is taken.',
      409,
    );
  let created: { userId: string; extension: number } | null = null;
  for (const extension of candidates.slice(0, EXTENSION_ATTEMPTS)) {
    try {
      created = await addTelecmiUser({
        credential,
        extension,
        name: target.full_name.trim().slice(0, 80) || 'CRM agent',
        phone,
        password: randomAgentPassword(),
      });
      break;
    } catch (error) {
      // Another admin may have taken the extension since the list was read.
      if (error instanceof TelecmiError && error.code === 'TELECMI_EXTENSION_TAKEN') continue;
      throw error;
    }
  }
  if (!created)
    throw new TelecmiAgentProvisionError(
      'TELECMI_NO_FREE_EXTENSION',
      'TeleCMI kept reporting the chosen extensions as taken. Try again.',
      409,
    );

  try {
    await linkAgent(admin, { ...input, connectionId, agentUserId: created.userId, phone });
  } catch (error) {
    // An agent the CRM cannot link still holds a paid seat, so it is removed
    // rather than left orphaned in TeleCMI.
    await removeTelecmiUser({ credential, userId: created.userId }).catch(() => undefined);
    throw error;
  }
  return {
    status: 'CREATED',
    agent_user_id: created.userId,
    extension: created.extension,
    connection_id: connectionId,
  };
}
