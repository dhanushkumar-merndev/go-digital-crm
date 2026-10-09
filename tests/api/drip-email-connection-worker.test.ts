import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDripDispatch } from '../../trigger/drip-dispatch';

const org = '00000000-0000-4000-8000-000000000001';
const connection = '00000000-0000-4000-8000-000000000002';
const message = {
  id: 'message-id',
  organization_id: org,
  channel: 'EMAIL',
  template_provider_id: '1',
  template_variables: { NAME: 'Dhanush' },
  recipient: 'dhanush@example.com',
  connected_account_id: connection,
  application_message_id: 'message-id',
  lease_token: 'lease',
};

async function mock(status = 'CONNECTED', connectedAccountId: string | null = connection) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', Buffer.from(rawKey).toString('base64url'));
  vi.stubEnv('BREVO_API_KEY', 'platform-key');
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify({ api_key: 'tenant-key' })),
  );
  const encrypted_payload =
    '\\x' +
    Buffer.from(
      JSON.stringify({
        version: 'AES-256-GCM-v1',
        iv: Buffer.from(iv).toString('base64url'),
        ciphertext: Buffer.from(ciphertext).toString('base64url'),
      }),
    ).toString('hex');
  const filters: Record<string, unknown[][]> = {};
  const from = vi.fn((table: string) => {
    filters[table] = [];
    const chain = {
      select: vi.fn(() => chain),
      is: vi.fn(() => chain),
      eq: vi.fn((...args: unknown[]) => {
        filters[table].push(args);
        return chain;
      }),
      maybeSingle: vi.fn(async () => ({
        data: table === 'connected_accounts' ? { status } : { encrypted_payload },
        error: null,
      })),
    };
    return chain;
  });
  const rpc = vi.fn(async (name: string) => ({
    data:
      name === 'claim_due_drip_messages'
        ? [{ ...message, connected_account_id: connectedAccountId }]
        : 0,
    error: null,
  }));
  const fetcher = vi.fn().mockResolvedValue(Response.json({ messageId: 'provider-id' }));
  vi.stubGlobal('fetch', fetcher);
  return {
    supabase: { from, rpc } as unknown as Parameters<typeof runDripDispatch>[0],
    rpc,
    filters,
    fetcher,
  };
}

describe('email drip connection worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('uses the encrypted tenant key and filters both account and credential by tenant', async () => {
    const m = await mock();
    expect(await runDripDispatch(m.supabase)).toMatchObject({ sent: 1, retried: 0 });
    expect(m.filters.connected_accounts).toContainEqual(['organization_id', org]);
    expect(m.filters.integration_credentials).toContainEqual(['organization_id', org]);
    expect(m.filters.integration_credentials).toContainEqual(['connected_account_id', connection]);
    expect(m.fetcher.mock.calls[0][1].headers['api-key']).toBe('tenant-key');
    expect(m.fetcher.mock.calls[0][1].headers['idempotency-key']).toBe(
      message.application_message_id,
    );
  });
  it('retains the existing platform email path for a tenant without a connection', async () => {
    const m = await mock('CONNECTED', null);
    expect(await runDripDispatch(m.supabase)).toMatchObject({ sent: 1 });
    expect(m.fetcher.mock.calls[0][1].headers['api-key']).toBe('platform-key');
    expect(m.filters).toEqual({});
  });
  it('does not send from a disconnected account or fall back to the platform key', async () => {
    const m = await mock('DISCONNECTED');
    expect(await runDripDispatch(m.supabase)).toMatchObject({ sent: 0, retried: 1 });
    expect(m.fetcher).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledWith(
      'retry_drip_message',
      expect.objectContaining({ target_safe_error_code: 'DRIP_EMAIL_NOT_CONNECTED' }),
    );
  });
});
