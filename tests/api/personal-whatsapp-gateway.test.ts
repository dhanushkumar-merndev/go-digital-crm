import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decrypt,
  encrypt,
  hasCapacity,
  sign,
  validSignature,
} from '../../services/whatsapp-gateway/src/security';
import { normalizeMessage } from '../../services/whatsapp-gateway/src/messages';
import { Gateway } from '../../services/whatsapp-gateway/src/gateway';
import { authState, type Rpc } from '../../services/whatsapp-gateway/src/store';

describe('personal WhatsApp security', () => {
  it('authenticates the complete request, expiry, and body', () => {
    const secret = 'a'.repeat(32),
      timestamp = String(Date.now()),
      nonce = randomUUID();
    const signature = sign(secret, 'POST', '/v1/sessions', timestamp, nonce, '{}');
    expect(validSignature(secret, 'POST', '/v1/sessions', timestamp, nonce, '{}', signature)).toBe(
      true,
    );
    expect(validSignature(secret, 'POST', '/v1/messages', timestamp, nonce, '{}', signature)).toBe(
      false,
    );
    expect(
      validSignature(
        secret,
        'POST',
        '/v1/sessions',
        timestamp,
        nonce,
        '{"injected":true}',
        signature,
      ),
    ).toBe(false);
    expect(
      validSignature(
        secret,
        'POST',
        '/v1/sessions',
        timestamp,
        nonce,
        '{}',
        signature,
        Date.now() + 61_000,
      ),
    ).toBe(false);
  });
  it('binds encrypted keys to their account and rejects tampering', () => {
    const key = randomBytes(32),
      encrypted = encrypt(key, 'account:creds', 'private session');
    expect(encrypted).not.toContain('private session');
    expect(decrypt(key, 'account:creds', encrypted)).toBe('private session');
    expect(() => decrypt(key, 'other:creds', encrypted)).toThrow();
    expect(() => decrypt(randomBytes(32), 'account:creds', encrypted)).toThrow();
  });
  it('honors both the hard five-session ceiling and memory threshold', () => {
    expect(hasCapacity(4, 5, 100 * 1024 * 1024, 512)).toBe(true);
    expect(hasCapacity(5, 100, 100 * 1024 * 1024, 512)).toBe(false);
    expect(hasCapacity(1, 5, 400 * 1024 * 1024, 512)).toBe(false);
  });
  it('discards groups, old history, unresolved LIDs, and view-once content', async () => {
    const base = {
      key: { id: 'message', remoteJid: '919876543210@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Hello' },
    };
    expect((await normalizeMessage(base, Date.now() - 10_000))?.body).toBe('Hello');
    expect(
      await normalizeMessage({ ...base, key: { ...base.key, remoteJid: '123@g.us' } }, 0),
    ).toBeNull();
    expect(
      await normalizeMessage({ ...base, key: { ...base.key, remoteJid: '1234567890@lid' } }, 0),
    ).toBeNull();
    expect(await normalizeMessage(base, Date.now() + 1000)).toBeNull();
    expect(
      await normalizeMessage(
        { ...base, message: { viewOnceMessage: { message: { conversation: 'Private' } } } },
        0,
      ),
    ).toBeNull();
  });
  it('resolves modern LID contacts from message metadata or the encrypted mapping store', async () => {
    const base = {
      key: { id: 'message', remoteJid: '1234567890@lid' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Hello' },
    };
    expect(
      (
        await normalizeMessage(
          {
            ...base,
            key: { ...base.key, remoteJidAlt: '919876543210@s.whatsapp.net' },
          },
          0,
        )
      )?.phone,
    ).toBe('919876543210');
    const resolve = vi.fn().mockResolvedValue('919876543210@s.whatsapp.net');
    expect((await normalizeMessage(base, 0, resolve))?.phone).toBe('919876543210');
    expect(resolve).toHaveBeenCalledWith('1234567890@lid');
  });
  it('restores persisted credential and Signal buffers without local auth files', async () => {
    const values: Record<string, string> = {};
    const store = vi.fn(async (operation: string, data: Record<string, unknown>) => {
      if (operation === 'keys_get')
        return Object.fromEntries(
          (data.ids as string[]).filter((id) => values[id]).map((id) => [id, values[id]]),
        );
      Object.assign(values, data);
      return {};
    });
    const key = randomBytes(32);
    const first = await authState(store as never, key, 'account');
    await first.state.keys.set({
      'pre-key': { key1: { private: Buffer.from([1, 2]), public: Buffer.from([3, 4]) } },
    });
    await first.save();
    const restored = await authState(store as never, key, 'account');
    expect(restored.state.creds.registrationId).toBe(first.state.creds.registrationId);
    const keys = await restored.state.keys.get('pre-key', ['key1']);
    expect(Buffer.from(keys.key1.private)).toEqual(Buffer.from([1, 2]));
  });
});

describe('Baileys gateway lifecycle with simulated sockets', () => {
  const gateways: Gateway[] = [];
  afterEach(async () => {
    for (const gateway of gateways) await gateway.shutdown();
    gateways.length = 0;
    vi.useRealTimers();
  });
  const setup = () => {
    const ev = new EventEmitter();
    const socket = {
      ev,
      user: { id: '919876543210:1@s.whatsapp.net' },
      signalRepository: {
        lidMapping: { getPNForLID: vi.fn().mockResolvedValue('919876543210@s.whatsapp.net') },
      },
      end: vi.fn(),
      logout: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'provider' } }),
    };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'personal_whatsapp_send_claim') return { phone: '919876543210', body: 'Reply' };
      if (args.target_operation === 'acquire')
        return {
          linked_at: new Date(Date.now() - 60_000).toISOString(),
          requested_at: new Date().toISOString(),
        };
      return {};
    });
    const factory = vi.fn(() => socket);
    const gateway = new Gateway({
      rpc: rpc as Rpc,
      encryptionKey: randomBytes(32),
      maxSessions: 5,
      memoryMb: 512,
      rss: () => 100_000_000,
      socketFactory: factory as never,
    });
    gateways.push(gateway);
    return {
      gateway,
      rpc,
      ev,
      socket,
      factory,
      identity: { connection_id: randomUUID(), generation: randomUUID() },
    };
  };
  const drain = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  it('publishes rotating QR codes and clears them when connected', async () => {
    const { gateway, ev, rpc, identity } = setup();
    await gateway.connect(identity);
    ev.emit('connection.update', { qr: 'first' });
    await drain();
    ev.emit('connection.update', { qr: 'second' });
    await drain();
    ev.emit('connection.update', { connection: 'open' });
    await drain();
    const operations = rpc.mock.calls
      .filter(([name]) => name === 'personal_whatsapp_gateway')
      .map(([, args]) => args.target_operation);
    expect(operations.filter((op) => op === 'qr')).toHaveLength(2);
    expect(operations).toContain('connected');
  });
  it('ingests a live LID message by resolving its phone-number mapping', async () => {
    const { gateway, ev, rpc, socket, identity } = setup();
    await gateway.connect(identity);
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'message', remoteJid: '1234567890@lid' },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { conversation: 'Hello' },
        },
      ],
    });
    await drain();
    expect(socket.signalRepository.lidMapping.getPNForLID).toHaveBeenCalledWith('1234567890@lid');
    expect(
      rpc.mock.calls.some(
        ([name, args]) =>
          name === 'personal_whatsapp_ingest' &&
          (args.target_data as { phone?: string }).phone === '919876543210',
      ),
    ).toBe(true);
  });
  it('recovers offline and initial text history while discarding media', async () => {
    const { gateway, ev, rpc, identity } = setup();
    await gateway.connect(identity);
    const base = {
      key: { id: 'offline', remoteJid: '919876543210@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000) - 3600,
      message: { conversation: 'Offline hello' },
    };
    ev.emit('messages.upsert', { type: 'append', messages: [base] });
    await drain();
    ev.emit('messaging-history.set', {
      messages: [
        { ...base, key: { ...base.key, id: 'history' } },
        {
          ...base,
          key: { ...base.key, id: 'image' },
          message: { imageMessage: { caption: 'Skip' } },
        },
      ],
    });
    await drain();
    const ingested = rpc.mock.calls
      .filter(([name]) => name === 'personal_whatsapp_ingest')
      .map(([, args]) => args.target_data as { provider_message_id: string; is_history: boolean });
    expect(ingested.map((item) => item.provider_message_id)).toEqual(['offline', 'history']);
    expect(ingested.every((item) => item.is_history)).toBe(true);
  });
  it('processes receipts and heartbeats while history ingestion is waiting', async () => {
    vi.useFakeTimers();
    const { gateway, ev, rpc, identity } = setup();
    await gateway.connect(identity);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'personal_whatsapp_ingest') await waiting;
      return original(name, args);
    });
    ev.emit('messaging-history.set', {
      messages: [
        {
          key: { id: 'history', remoteJid: '919876543210@s.whatsapp.net' },
          messageTimestamp: Math.floor(Date.now() / 1000) - 3600,
          message: { conversation: 'History' },
        },
      ],
    });
    await drain();
    expect(rpc.mock.calls.some(([name]) => name === 'personal_whatsapp_ingest')).toBe(true);
    ev.emit('messages.update', [{ key: { fromMe: true, id: 'reply' }, update: { status: 4 } }]);
    await vi.advanceTimersByTimeAsync(10_000);
    try {
      expect(
        rpc.mock.calls.some(
          ([name, args]) => name === 'personal_whatsapp_receipt' && args.target_status === 'READ',
        ),
      ).toBe(true);
      expect(rpc.mock.calls.some(([, args]) => args.target_operation === 'heartbeat')).toBe(true);
    } finally {
      release();
      await drain();
    }
  });
  it('does not send twice and never retries an uncertain provider response', async () => {
    const { gateway, rpc, socket, identity } = setup();
    await gateway.connect(identity);
    socket.sendMessage.mockRejectedValueOnce(new Error('Network failed after write'));
    const result = await gateway.send(identity, randomUUID());
    expect(result.status).toBe('UNKNOWN');
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      rpc.mock.calls.some(
        ([name, args]) =>
          name === 'personal_whatsapp_send_result' && args.target_status === 'UNKNOWN',
      ),
    ).toBe(true);
  });
  it('stops on logout and does not create a reconnect loop', async () => {
    const { gateway, ev, rpc, socket, identity, factory } = setup();
    await gateway.connect(identity);
    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await drain();
    expect(socket.end).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.some(([, args]) => args.target_operation === 'logged_out')).toBe(true);
  });
  it('reconnects transient socket failures with backoff and releases leases at shutdown', async () => {
    vi.useFakeTimers();
    const { gateway, ev, rpc, identity, factory } = setup();
    await gateway.connect(identity);
    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await drain();
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(factory).toHaveBeenCalledTimes(2);
    await gateway.shutdown();
    expect(rpc.mock.calls.some(([, args]) => args.target_operation === 'release')).toBe(true);
  });
});
