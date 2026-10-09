import { afterEach, describe, expect, it, vi } from 'vitest';
import { listTelecmiAgents } from '../../supabase/functions/_shared/telecmi';
const credential = { app_id: 33338826, app_secret: 'server-only' };
const agent = (extension: number) => ({
  agent_id: `${extension}_33338826`,
  extension,
  name: 'Agent',
  phone: '919876543210',
  password: 'private-softphone',
});
afterEach(() => vi.unstubAllGlobals());
describe('TeleCMI complete agent directory', () => {
  it('walks all pages and projects no softphone passwords', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          code: 200,
          count: 11,
          agents: Array.from({ length: 10 }, (_, i) => agent(100 + i)),
        }),
      )
      .mockResolvedValueOnce(Response.json({ code: 200, count: 11, agents: [agent(110)] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await listTelecmiAgents(credential);
    expect(result).toHaveLength(11);
    expect(JSON.stringify(result)).not.toContain('private-softphone');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { code: 200, count: 5, agents: [] },
    { code: 200, count: 1 },
    { code: 200, count: 1, agents: [{ agent_id: 'wrong-app' }] },
    { code: 200, agents: [agent(101)] },
    { code: 200, count: null, agents: [] },
    { code: 200, count: '', agents: [] },
    { code: 200, count: 'bad', agents: [] },
  ])('refuses a malformed or incomplete directory as evidence of absence', async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload)),
    );
    await expect(listTelecmiAgents(credential)).rejects.toThrow('TELECMI_REQUEST_REJECTED');
  });
  it('refuses a directory that still has more agents at the page cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) =>
        Response.json({
          code: 200,
          count: 1001,
          agents: Array.from({ length: 10 }, (_, i) =>
            agent(100 + (JSON.parse(options.body).page - 1) * 10 + i),
          ),
        }),
      ),
    );
    await expect(listTelecmiAgents(credential)).rejects.toThrow('TELECMI_REQUEST_REJECTED');
  });
  it('rejects repeated pages instead of treating duplicate IDs as a complete count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          code: 200,
          count: 20,
          agents: Array.from({ length: 10 }, (_, i) => agent(100 + i)),
        }),
      ),
    );
    await expect(listTelecmiAgents(credential)).rejects.toThrow('TELECMI_REQUEST_REJECTED');
  });
});
