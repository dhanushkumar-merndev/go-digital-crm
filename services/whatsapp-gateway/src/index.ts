import './logging.js';
import { createServer } from 'node:http';
import { z } from 'zod';
import { database } from './store.js';
import { Gateway } from './gateway.js';
import { validSignature } from './security.js';

const env = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    PERSONAL_WHATSAPP_ENCRYPTION_KEY: z.string().min(40),
    PERSONAL_WHATSAPP_SIGNING_SECRET: z.string().min(32),
    PERSONAL_WHATSAPP_MAX_SESSIONS: z.coerce.number().int().min(1).max(5).default(5),
    PERSONAL_WHATSAPP_MEMORY_MB: z.coerce.number().int().min(128).max(512).default(512),
    PORT: z.coerce.number().int().min(1).max(65535).default(10000),
    HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('0.0.0.0'),
  })
  .safeParse(process.env);
if (!env.success) throw new Error('GATEWAY_CONFIGURATION_INVALID');
const config = env.data;
const encryptionKey = Buffer.from(config.PERSONAL_WHATSAPP_ENCRYPTION_KEY, 'base64');
if (encryptionKey.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY_INVALID');
const { client, rpc } = database(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
const gateway = new Gateway({
  rpc,
  encryptionKey,
  maxSessions: config.PERSONAL_WHATSAPP_MAX_SESSIONS,
  memoryMb: config.PERSONAL_WHATSAPP_MEMORY_MB,
});
const identity = z.object({ connection_id: z.uuid(), generation: z.uuid() });
let healthy = false;
let restoring = false;

async function restore() {
  if (restoring) return;
  restoring = true;
  try {
    await rpc('personal_whatsapp_reconcile', {});
    const { data, error } = await client
      .from('personal_whatsapp_sessions')
      .select('connection_id,generation')
      .eq('enabled', true)
      .order('requested_at')
      .limit(5);
    if (error) throw new Error('RESTORE_UNAVAILABLE');
    healthy = true;
    for (const row of data ?? []) {
      try {
        await gateway.connect(identity.parse(row));
      } catch {
        /* Retry on the next bounded restore pass. */
      }
    }
  } catch {
    healthy = false;
  } finally {
    restoring = false;
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  const reply = (status: number, data: unknown) => {
    response.writeHead(status);
    response.end(JSON.stringify(data));
  };
  const method = request.method ?? '';
  const path = request.url ?? '';
  if (method === 'GET' && path === '/health') {
    reply(healthy ? 200 : 503, { ok: healthy });
    return;
  }
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 8192) {
        reply(413, { error: 'REQUEST_TOO_LARGE' });
        return;
      }
    }
    const header = (name: string) => String(request.headers[name] ?? '');
    const timestamp = header('x-gateway-timestamp');
    const nonce = header('x-gateway-nonce');
    if (
      !validSignature(
        config.PERSONAL_WHATSAPP_SIGNING_SECRET,
        method,
        path,
        timestamp,
        nonce,
        body,
        header('x-gateway-signature'),
      ) ||
      !(await rpc<boolean>('personal_whatsapp_nonce', {
        target_nonce: nonce,
        target_expires: new Date(Date.now() + 120_000).toISOString(),
      }))
    ) {
      reply(401, { error: 'GATEWAY_AUTH_REQUIRED' });
      return;
    }
    if (method === 'POST' && path === '/v1/sessions') {
      await gateway.connect(identity.parse(JSON.parse(body)));
      reply(202, { ok: true });
    } else if (method === 'POST' && path === '/v1/history') {
      const input = identity.extend({ conversation_id: z.uuid() }).parse(JSON.parse(body));
      reply(202, await gateway.sync(input, input.conversation_id));
    } else if (method === 'POST' && path === '/v1/messages') {
      const input = identity.extend({ message_id: z.uuid() }).parse(JSON.parse(body));
      reply(200, await gateway.send(input, input.message_id));
    } else if (method === 'DELETE' && /^\/v1\/sessions\/[0-9a-f-]{36}$/i.test(path)) {
      const connectionId = z.uuid().parse(path.split('/').at(-1));
      // The Edge function must revoke the DB generation before closing the socket.
      const { data } = await client
        .from('personal_whatsapp_sessions')
        .select('enabled')
        .eq('connection_id', connectionId)
        .single();
      if (data?.enabled !== false) throw new Error('SESSION_NOT_REVOKED');
      await gateway.disconnect(connectionId);
      reply(200, { ok: true });
    } else reply(404, { error: 'NOT_FOUND' });
  } catch (error) {
    const message =
      error instanceof Error && /^PERSONAL_WHATSAPP_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'GATEWAY_REQUEST_FAILED';
    reply(409, { error: message });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.PORT, config.HOST);
void restore();
const restoreTimer = setInterval(() => void restore(), 30_000);
const shutdown = () => {
  healthy = false;
  clearInterval(restoreTimer);
  server.close();
  void gateway.shutdown().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 25_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Provider exceptions may embed cryptographic material. Never let Node print
// their payload/stack through its default uncaught-error handler.
const fatal = () => {
  process.stderr.write('GATEWAY_FATAL_ERROR\n');
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
