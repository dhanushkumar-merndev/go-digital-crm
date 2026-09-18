import { createHmac, randomUUID } from 'node:crypto';
import makeWASocket, {
  DisconnectReason,
  generateMessageIDV2,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { authState, sessionStore, type Rpc, type SessionIdentity } from './store.js';
import { hasCapacity } from './security.js';
import { normalizeMessage } from './messages.js';

type Session = {
  identity: SessionIdentity;
  socket?: WASocket;
  store: ReturnType<typeof sessionStore>;
  auth?: Awaited<ReturnType<typeof authState>>;
  stopped: boolean;
  failures: number;
  linkedAt: number;
  requestedAt: number;
  queue: Promise<void>;
  ingestQueue: Promise<void>;
  queued: number;
  reconnect?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
};
type Dependencies = {
  rpc: Rpc;
  encryptionKey: Buffer;
  maxSessions: number;
  memoryMb: number;
  socketFactory?: typeof makeWASocket;
  rss?: () => number;
};

export class Gateway {
  private sessions = new Map<string, Session>();
  private worker = randomUUID();
  private starting = new Map<string, Promise<void>>();
  private closing = false;
  constructor(private deps: Dependencies) {}

  async connect(identity: SessionIdentity) {
    if (this.closing) throw new Error('GATEWAY_SHUTTING_DOWN');
    const existing = this.sessions.get(identity.connection_id);
    if (existing && existing.identity.generation !== identity.generation)
      await this.stop(existing, false);
    else if (existing) return;
    const pending = this.starting.get(identity.connection_id);
    if (pending) return pending;
    if (
      !hasCapacity(
        this.sessions.size + this.starting.size,
        this.deps.maxSessions,
        (this.deps.rss ?? (() => process.memoryUsage().rss))(),
        this.deps.memoryMb,
      )
    ) {
      throw new Error('PERSONAL_WHATSAPP_CAPACITY');
    }
    const start = this.start(identity);
    this.starting.set(identity.connection_id, start);
    try {
      await start;
    } finally {
      this.starting.delete(identity.connection_id);
    }
  }

  private async start(identity: SessionIdentity) {
    const store = sessionStore(this.deps.rpc, identity, this.worker);
    const row = await store<{ linked_at: string | null; requested_at: string }>('acquire');
    const session: Session = {
      identity,
      store,
      stopped: false,
      failures: 0,
      linkedAt: row.linked_at ? Date.parse(row.linked_at) : Date.now(),
      requestedAt: Date.parse(row.requested_at),
      queue: Promise.resolve(),
      ingestQueue: Promise.resolve(),
      queued: 0,
    };
    this.sessions.set(identity.connection_id, session);
    try {
      session.auth = await authState(store, this.deps.encryptionKey, identity.connection_id);
      session.heartbeat = setInterval(
        () =>
          this.enqueue(session, async () => {
            await store('heartbeat');
          }),
        10_000,
      );
      await this.open(session);
    } catch (error) {
      await this.stop(session, false);
      throw error;
    }
  }

  private enqueue(
    session: Session,
    action: () => Promise<void>,
    lane: 'queue' | 'ingestQueue' = 'queue',
  ) {
    if (session.stopped) return;
    if (++session.queued > 100) {
      void this.stop(session, false);
      return;
    }
    session[lane] = session[lane]
      .then(async () => {
        if (!session.stopped) await action();
      })
      .catch(async () => {
        await this.stop(session, false);
      })
      .finally(() => {
        session.queued--;
      });
  }

  private async open(session: Session) {
    if (session.stopped || !session.auth) return;
    const socket = (this.deps.socketFactory ?? makeWASocket)({
      auth: session.auth.state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) =>
        jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: 15_000,
      qrTimeout: 45_000,
      getMessage: async () => undefined,
    });
    session.socket = socket;
    socket.ev.on('creds.update', () => {
      void session.auth!.save().catch(() => this.stop(session, false));
    });
    socket.ev.on('connection.update', (update) =>
      this.enqueue(session, async () => {
        if (session.socket !== socket) return;
        if (update.qr) await session.store('qr', { qr: update.qr });
        if (update.connection === 'open') {
          const number = socket.user?.id.split(':')[0].split('@')[0];
          if (!number || !/^\d{7,15}$/.test(number)) throw new Error('PERSONAL_ACCOUNT_INVALID');
          await session.auth!.save();
          await session.store('connected', {
            masked_phone: `*******${number.slice(-4)}`,
            account_hash: createHmac('sha256', this.deps.encryptionKey)
              .update(number)
              .digest('hex'),
          });
          session.failures = 0;
        }
        if (update.connection === 'close') {
          const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode;
          if (
            code === DisconnectReason.loggedOut ||
            code === DisconnectReason.badSession ||
            code === DisconnectReason.connectionReplaced ||
            code === DisconnectReason.forbidden
          ) {
            await session.store('logged_out');
            await this.stop(session, false);
            return;
          }
          if (++session.failures > 6) {
            await session.store('error');
            await this.stop(session, false);
            return;
          }
          await session.store('reconnecting');
          session.reconnect = setTimeout(
            () => {
              void this.open(session).catch(() => this.stop(session, false));
            },
            code === DisconnectReason.restartRequired
              ? 500
              : Math.min(30_000, 1000 * 2 ** session.failures),
          );
        }
      }),
    );
    const ingest = (messages: Parameters<typeof normalizeMessage>[0][], history: boolean) => {
      // One bounded queue item per provider batch, without media downloads.
      this.enqueue(
        session,
        async () => {
          for (const message of messages.slice(-1000)) {
            if (session.socket !== socket || session.stopped) return;
            const normalized = await normalizeMessage(
              message,
              session.linkedAt,
              (lid) => socket.signalRepository.lidMapping.getPNForLID(lid),
              history,
            );
            if (!normalized) continue;
            await this.deps.rpc('personal_whatsapp_ingest', {
              target_connection_id: session.identity.connection_id,
              target_generation: session.identity.generation,
              target_worker: this.worker,
              target_data: normalized,
            });
          }
        },
        'ingestQueue',
      );
    };
    socket.ev.on('messaging-history.set', ({ messages }) => ingest(messages, true));
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      ingest(messages, type === 'append');
    });
    socket.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (!key.fromMe || !key.id || update.status == null) continue;
        const status =
          update.status >= 4
            ? 'READ'
            : update.status === 3
              ? 'DELIVERED'
              : update.status === 2
                ? 'SENT'
                : null;
        if (status)
          this.enqueue(session, async () => {
            await this.deps.rpc('personal_whatsapp_receipt', {
              target_connection_id: session.identity.connection_id,
              target_provider_id: key.id,
              target_status: status,
            });
          });
      }
    });
  }

  async send(identity: SessionIdentity, messageId: string) {
    const session = this.sessions.get(identity.connection_id);
    if (!session?.socket || session.stopped || session.identity.generation !== identity.generation)
      throw new Error('PERSONAL_WHATSAPP_DISCONNECTED');
    const providerId = generateMessageIDV2(session.socket.user?.id);
    const send = await this.deps.rpc<{ phone: string; body: string }>(
      'personal_whatsapp_send_claim',
      {
        target_connection_id: identity.connection_id,
        target_generation: identity.generation,
        target_worker: this.worker,
        target_message_id: messageId,
        target_provider_id: providerId,
      },
    );
    try {
      await session.socket.sendMessage(
        `${send.phone}@s.whatsapp.net`,
        { text: send.body, linkPreview: undefined },
        { messageId: providerId },
      );
    } catch {
      await this.result(identity.connection_id, messageId, 'UNKNOWN');
      return { message_id: messageId, status: 'UNKNOWN' };
    }
    await this.result(identity.connection_id, messageId, 'SENT');
    return { message_id: messageId, status: 'SENT' };
  }

  async sync(identity: SessionIdentity, conversationId: string) {
    const session = this.sessions.get(identity.connection_id);
    if (!session?.socket || session.stopped || session.identity.generation !== identity.generation)
      throw new Error('PERSONAL_WHATSAPP_DISCONNECTED');
    await session.store('heartbeat');
    const anchor = await this.deps.rpc<{
      phone: string;
      provider_message_id: string;
      from_me: boolean;
      timestamp_ms: number;
    }>('personal_whatsapp_sync_anchor', {
      target_connection_id: identity.connection_id,
      target_generation: identity.generation,
      target_worker: this.worker,
      target_conversation_id: conversationId,
    });
    await session.socket.fetchMessageHistory(
      100,
      {
        remoteJid: `${anchor.phone}@s.whatsapp.net`,
        id: anchor.provider_message_id,
        fromMe: anchor.from_me,
      },
      anchor.timestamp_ms,
    );
    return { requested: true };
  }

  private result(connectionId: string, messageId: string, status: string) {
    return this.deps.rpc('personal_whatsapp_send_result', {
      target_connection_id: connectionId,
      target_message_id: messageId,
      target_status: status,
    });
  }

  async disconnect(connectionId: string) {
    const session = this.sessions.get(connectionId);
    if (session) await this.stop(session, true);
  }

  private async stop(session: Session, logout: boolean) {
    if (session.stopped) return;
    session.stopped = true;
    clearInterval(session.heartbeat);
    clearTimeout(session.reconnect);
    if (logout) {
      try {
        await session.socket?.logout();
      } catch {
        /* Locally revoked even when WhatsApp is offline. */
      }
    }
    session.socket?.end(new Error('SESSION_CLOSED'));
    try {
      await session.auth?.flush();
    } catch {
      /* No secrets or provider payloads in logs. */
    }
    try {
      await session.store('release');
    } catch {
      /* Lease may already be revoked. */
    }
    if (this.sessions.get(session.identity.connection_id) === session)
      this.sessions.delete(session.identity.connection_id);
  }

  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => this.stop(session, false)),
    );
  }
}
