import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failure, preflight, requestId, success } from '../../supabase/functions/_shared/http';

const ourId = randomUUID(),
  otherId = randomUUID(),
  actor = randomUUID(),
  org = randomUUID();
const code = ts.transpileModule(
  readFileSync('supabase/functions/vehicle-comparison-ai/index.ts', 'utf8').replace(
    /^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,
    '',
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
let handler: (request: Request) => Promise<Response>;
let authorized: boolean, configured: boolean;
let rpc: ReturnType<typeof vi.fn>,
  fetchProvider: ReturnType<typeof vi.fn>,
  access: ReturnType<typeof vi.fn>;
const comparison = {
  ours: { model: 'City', specifications: { power: '150 PS' } },
  other: { model: 'Jazz', specifications: { power: null } },
};
function request() {
  return new Request('http://test/vehicle-comparison-ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ our_id: ourId, other_id: otherId, request_id: randomUUID() }),
  });
}
describe('AI comparison Edge boundary', () => {
  beforeEach(() => {
    authorized = true;
    configured = true;
    access = vi.fn(async () => ({ data: comparison, error: null }));
    rpc = vi.fn(async (name: string) => ({
      data: name === 'begin_vehicle_comparison_ai' ? { replayed: false, status: 'RUNNING' } : null,
      error: null,
    }));
    fetchProvider = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Power is recorded only for City; confirm Jazz specifications.',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const admin = {
      rpc,
      from: (table: string) => {
        const response = () => ({
          data:
            table === 'profiles'
              ? { organization_id: org }
              : table === 'connected_accounts'
                ? configured
                  ? [
                      {
                        id: randomUUID(),
                        connection_config: {
                          capabilities: ['TEXT_GENERATION'],
                          models: { text_model: 'configured/model' },
                        },
                      },
                    ]
                  : []
                : { encrypted_payload: 'encrypted' },
          error: null,
        });
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'is', 'order']) chain[method] = () => chain;
        chain.single = async () => response();
        chain.limit = async () => response();
        return chain;
      },
    };
    new Function(
      'z',
      'authenticatedClient',
      'serviceClient',
      'decryptJson',
      'failure',
      'preflight',
      'requestId',
      'success',
      'Deno',
      'fetch',
      code,
    )(
      z,
      () => ({
        auth: {
          getUser: async () => ({ data: { user: authorized ? { id: actor } : null }, error: null }),
        },
        rpc: access,
      }),
      () => admin,
      async () => ({ api_key: 'server-only-secret' }),
      failure,
      preflight,
      requestId,
      success,
      {
        serve: (fn: typeof handler) => {
          handler = fn;
        },
      },
      fetchProvider,
    );
  });
  it('only sends server-fetched specifications after reserving one credit', async () => {
    const res = await handler(request());
    expect(res.status).toBe(200);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      'begin_vehicle_comparison_ai',
      'finish_vehicle_comparison_ai',
    ]);
    const sent = JSON.parse(fetchProvider.mock.calls[0][1].body);
    expect(sent.messages[1].content).toBe(JSON.stringify(comparison));
    expect(await res.text()).not.toContain('server-only-secret');
    expect(access).toHaveBeenCalledTimes(2);
  });
  it('does not call the provider or charge when authentication fails', async () => {
    authorized = false;
    expect((await handler(request())).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchProvider).not.toHaveBeenCalled();
  });
  it('does not charge when the provider is not configured', async () => {
    configured = false;
    expect((await handler(request())).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refunds on provider failure without exposing provider errors', async () => {
    fetchProvider.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'secret provider trace' } }), {
        status: 429,
      }),
    );
    const res = await handler(request());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret provider trace');
    expect(rpc).toHaveBeenLastCalledWith(
      'finish_vehicle_comparison_ai',
      expect.objectContaining({ target_summary: null }),
    );
  });
  it('refunds and refuses output if consent changes during generation', async () => {
    access
      .mockResolvedValueOnce({ data: comparison, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('withdrawn') });
    const res = await handler(request());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('confirm Jazz');
    expect(rpc).toHaveBeenLastCalledWith(
      'finish_vehicle_comparison_ai',
      expect.objectContaining({ target_summary: null }),
    );
  });
  it('does not rerun or recharge completed requests', async () => {
    rpc.mockResolvedValueOnce({
      data: { replayed: true, status: 'COMPLETED', summary: 'Already generated' },
      error: null,
    });
    expect((await handler(request())).status).toBe(200);
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
