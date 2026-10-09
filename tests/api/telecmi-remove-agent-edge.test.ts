import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failure, preflight, requestId, success } from '../../supabase/functions/_shared/http';
import {
  describeTelecmiFailure,
  normalizeTelecmiPhone,
  TelecmiError,
} from '../../supabase/functions/_shared/telecmi';

const org = randomUUID(),
  actor = randomUUID(),
  branch = randomUUID(),
  connectionId = randomUUID();
const code = ts.transpileModule(
  readFileSync('supabase/functions/integration-telecmi-remove-agent/index.ts', 'utf8').replace(
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
let listAgents: ReturnType<typeof vi.fn>, removeAgent: ReturnType<typeof vi.fn>;
let storedCredential: ReturnType<typeof vi.fn>;
type RpcResult = { data: unknown; error: unknown };
let begin: ReturnType<typeof vi.fn<(input: unknown) => Promise<RpcResult>>>;
let finish: ReturnType<typeof vi.fn<(input: unknown) => Promise<RpcResult>>>;
function request(patch: Record<string, unknown> = {}) {
  return new Request('http://test/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organization_id: org,
      scope_mode: 'ONE_BRANCH',
      branch_ids: [branch],
      app_id: 33338826,
      app_secret: 'server-only-secret',
      agent_id: '601_33338826',
      request_id: randomUUID(),
      ...patch,
    }),
  });
}
describe('TeleCMI remove-agent Edge boundary', () => {
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
        agentId: '601_33338826',
        name: 'Unused',
        phone: '9876543219',
        extension: 601,
        password: 'private-softphone',
      },
    ]);
    removeAgent = vi.fn(async () => undefined);
    storedCredential = vi.fn(async () => ({ app_id: 33338826, app_secret: 'stored-secret' }));
    begin = vi.fn(async () => ({ data: { claimed: true, status: 'PENDING' }, error: null }));
    finish = vi.fn(async () => ({ data: null, error: null }));
    new Function(
      'z',
      'failure',
      'preflight',
      'getRequestId',
      'success',
      'authenticatedClient',
      'serviceClient',
      'describeTelecmiFailure',
      'listTelecmiAgents',
      'normalizeTelecmiPhone',
      'removeTelecmiUser',
      'loadTelecmiCredential',
      'Deno',
      code,
    )(
      z,
      failure,
      preflight,
      requestId,
      success,
      () => ({
        auth: { getUser: async () => ({ data: { user: signedIn ? { id: actor } : null } }) },
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
      () => ({
        rpc: (name: string, input: unknown) =>
          name === 'begin_telecmi_agent_removal' ? begin(input) : finish(input),
      }),
      describeTelecmiFailure,
      listAgents,
      normalizeTelecmiPhone,
      removeAgent,
      storedCredential,
      {
        serve: (fn: typeof handler) => {
          handler = fn;
        },
      },
    );
  });
  it('claims and audits removal with the provider-verified normalized mobile, without returning secrets', async () => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        target_organization_id: org,
        target_actor_id: actor,
        target_agent_id: '601_33338826',
        target_phone: '919876543219',
      }),
    );
    expect(removeAgent).toHaveBeenCalledWith({
      credential: { app_id: 33338826, app_secret: 'server-only-secret' },
      userId: '601_33338826',
    });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ target_status: 'COMPLETED' }));
    expect(await response.text()).not.toMatch(/server-only-secret|private-softphone|password/);
  });
  it.each(['scope', 'tenant', 'role', 'mfa', 'session'])(
    'refuses unauthorized %s before provider access',
    async (reason) => {
      if (reason === 'scope') permitted = false;
      if (reason === 'tenant') access.organization_id = randomUUID();
      if (reason === 'role') access.role_key = 'telecaller';
      if (reason === 'mfa') access.mfa_satisfied = false;
      if (reason === 'session') signedIn = false;
      expect((await handler(request())).status).toBe(reason === 'session' ? 401 : 403);
      expect(listAgents).not.toHaveBeenCalled();
      expect(removeAgent).not.toHaveBeenCalled();
    },
  );
  it('protects an in-use agent when the list was stale', async () => {
    begin.mockResolvedValue({ data: null, error: { message: 'TELECMI_AGENT_IN_USE' } });
    expect((await handler(request())).status).toBe(409);
    expect(removeAgent).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it('releases a failed provider claim without exposing provider errors', async () => {
    removeAgent.mockRejectedValue(new TelecmiError('TELECMI_AUTH_REJECTED'));
    const response = await handler(request());
    expect(response.status).toBe(502);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ target_status: 'FAILED' }));
    expect(await response.text()).not.toMatch(/private-softphone|server-only-secret/);
  });
  it('keeps uncertain provider outcomes reserved until a later provider refresh', async () => {
    removeAgent.mockRejectedValue(new TelecmiError('TELECMI_UNREACHABLE'));
    const response = await handler(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('TELECMI_REMOVAL_OUTCOME_UNKNOWN');
    expect(finish).not.toHaveBeenCalled();
  });
  it('does not remove a second time when a completed request is retried', async () => {
    begin.mockResolvedValue({ data: { claimed: false, status: 'COMPLETED' }, error: null });
    expect((await handler(request())).status).toBe(200);
    expect(removeAgent).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it('reports the partial outcome if provider removal succeeded but the audit write failed', async () => {
    finish.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    const response = await handler(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('TELECMI_REMOVAL_STATUS_PENDING');
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it('refuses a saved connection outside the actor scope before loading its secret', async () => {
    connectionAllowed = false;
    expect(
      (await handler(request({ connection_id: connectionId, app_secret: undefined }))).status,
    ).toBe(403);
    expect(storedCredential).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });
  it('requires the matching app secret for a changed saved app ID', async () => {
    storedCredential.mockResolvedValue({ app_id: 2223012, app_secret: 'stored-secret' });
    expect(
      (await handler(request({ connection_id: connectionId, app_secret: undefined }))).status,
    ).toBe(422);
    expect(listAgents).not.toHaveBeenCalled();
  });
  it('rejects an agent from another app without making provider calls', async () => {
    expect((await handler(request({ agent_id: '601_2223012' }))).status).toBe(422);
    expect(listAgents).not.toHaveBeenCalled();
  });
});
