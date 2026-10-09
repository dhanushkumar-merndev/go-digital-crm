import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failure, preflight, requestId, success } from '../../supabase/functions/_shared/http';
import {
  availableTelecmiAgents,
  telecmiAgentManagementList,
} from '../../supabase/functions/_shared/telecmi-agent-availability';
import { describeTelecmiFailure } from '../../supabase/functions/_shared/telecmi';

const org = randomUUID(),
  connectionId = randomUUID(),
  branch = randomUUID();
const code = ts.transpileModule(
  readFileSync('supabase/functions/integration-telecmi-list-agents/index.ts', 'utf8').replace(
    /^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,
    '',
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
let handler: (request: Request) => Promise<Response>;
let permitted: boolean, connectionAllowed: boolean, signedIn: boolean;
let access: {
  destination: string;
  organization_id: string;
  role_key: string;
  mfa_satisfied: boolean;
};
let listAgents: ReturnType<typeof vi.fn>, storedCredential: ReturnType<typeof vi.fn>;

function request(patch: Record<string, unknown> = {}) {
  return new Request('http://test/integration-telecmi-list-agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organization_id: org,
      scope_mode: 'ONE_BRANCH',
      branch_ids: [branch],
      app_id: 33338826,
      app_secret: 'server-only-secret',
      ...patch,
    }),
  });
}

describe('available TeleCMI agents Edge boundary', () => {
  beforeEach(() => {
    permitted = true;
    connectionAllowed = true;
    signedIn = true;
    access = {
      destination: 'CRM',
      organization_id: org,
      role_key: 'client-admin',
      mfa_satisfied: true,
    };
    listAgents = vi.fn(async () => [
      {
        agentId: '101_33338826',
        name: 'In use',
        extension: 101,
        phone: '919876543210',
        password: 'private-softphone',
      },
      {
        agentId: '102_33338826',
        name: 'Available',
        extension: 102,
        phone: '919876543211',
        password: 'private-softphone',
      },
    ]);
    storedCredential = vi.fn(async () => ({ app_id: 33338826, app_secret: 'stored-secret' }));
    const admin = {
      rpc: async (name: string, input: Record<string, unknown>) => {
        if (name === 'reconcile_telecmi_agent_removals') return { data: null, error: null };
        expect(name).toBe('get_telecmi_agent_reservations');
        expect(input.target_organization_id).toBe(org);
        expect(input.target_external_account_id).toBe('33338826');
        return { data: [{ user_id: '101_33338826', phone: '919876543210' }], error: null };
      },
    };
    new Function(
      'z',
      'failure',
      'preflight',
      'getRequestId',
      'success',
      'authenticatedClient',
      'serviceClient',
      'listTelecmiAgents',
      'loadTelecmiCredential',
      'availableTelecmiAgents',
      'telecmiAgentManagementList',
      'describeTelecmiFailure',
      'Deno',
      code,
    )(
      z,
      failure,
      preflight,
      requestId,
      success,
      () => ({
        auth: { getUser: async () => ({ data: { user: signedIn ? { id: randomUUID() } : null } }) },
        rpc: async (name: string) => ({
          data:
            name === 'get_access_context'
              ? access
              : name === 'authorize_integration_connection_action'
                ? connectionAllowed
                : permitted,
          error: null,
        }),
      }),
      () => admin,
      listAgents,
      storedCredential,
      availableTelecmiAgents,
      telecmiAgentManagementList,
      describeTelecmiFailure,
      {
        serve: (fn: typeof handler) => {
          handler = fn;
        },
      },
    );
  });

  it('returns only unused agents and never app or softphone secrets', async () => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.agents).toEqual([
      { agent_id: '102_33338826', name: 'Available', extension: 102, phone: '919876543211' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/server-only-secret|private-softphone|password/);
    expect(listAgents).toHaveBeenCalledWith({ app_id: 33338826, app_secret: 'server-only-secret' });
  });

  it.each(['scope', 'tenant', 'role', 'mfa', 'session'])(
    'refuses unauthorized %s before provider access',
    async (reason) => {
      if (reason === 'scope') permitted = false;
      if (reason === 'tenant') access.organization_id = randomUUID();
      if (reason === 'role') access.role_key = 'telecaller';
      if (reason === 'mfa') access.mfa_satisfied = false;
      if (reason === 'session') signedIn = false;
      const response = await handler(request());
      expect(response.status).toBe(reason === 'session' ? 401 : 403);
      expect(listAgents).not.toHaveBeenCalled();
    },
  );

  it('reuses the server-held credential only for an authorized saved connection', async () => {
    const response = await handler(request({ connection_id: connectionId, app_secret: undefined }));
    expect(response.status).toBe(200);
    expect(listAgents).toHaveBeenCalledWith({ app_id: 33338826, app_secret: 'stored-secret' });
    expect(await response.text()).not.toContain('stored-secret');
  });

  it('does not load another connections credential when connection access is denied', async () => {
    connectionAllowed = false;
    const response = await handler(request({ connection_id: connectionId, app_secret: undefined }));
    expect(response.status).toBe(403);
    expect(storedCredential).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('requires a new secret if the app ID differs from the stored credential', async () => {
    storedCredential.mockResolvedValue({ app_id: 2223012, app_secret: 'stored-secret' });
    const response = await handler(request({ connection_id: connectionId, app_secret: undefined }));
    expect(response.status).toBe(422);
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('rejects all-branch scope with selected branches', async () => {
    const response = await handler(request({ scope_mode: 'ALL_BRANCHES' }));
    expect(response.status).toBe(422);
    expect(listAgents).not.toHaveBeenCalled();
  });
});
