import { createClient } from '@supabase/supabase-js';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { decrypt, encrypt } from './security.js';

export type Rpc = <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
export type SessionIdentity = { connection_id: string; generation: string };

export function database(url: string, secret: string) {
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc: Rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await client.rpc(name, args);
    if (error)
      throw new Error(
        /^[A-Z_]+$/.test(error.message) ? error.message : 'DATABASE_OPERATION_FAILED',
      );
    return data as T;
  };
  return { client, rpc };
}

export function sessionStore(rpc: Rpc, identity: SessionIdentity, worker: string) {
  return <T = unknown>(operation: string, data: Record<string, unknown> = {}) =>
    rpc<T>('personal_whatsapp_gateway', {
      target_connection_id: identity.connection_id,
      target_generation: identity.generation,
      target_worker: worker,
      target_operation: operation,
      target_data: data,
    });
}

export async function authState(
  store: ReturnType<typeof sessionStore>,
  key: Buffer,
  connectionId: string,
) {
  let writes = Promise.resolve();
  const encode = (id: string, value: unknown) =>
    encrypt(key, `${connectionId}:${id}`, JSON.stringify(value, BufferJSON.replacer));
  const decode = (id: string, value: string) =>
    JSON.parse(decrypt(key, `${connectionId}:${id}`, value), BufferJSON.reviver);
  const stored = await store<Record<string, string>>('keys_get', { ids: ['creds'] });
  const creds = stored.creds ? decode('creds', stored.creds) : initAuthCreds();
  const save = (data: Record<string, unknown>) => {
    const encoded = Object.fromEntries(
      Object.entries(data).map(([id, value]) => [id, value == null ? null : encode(id, value)]),
    );
    const next = writes.then(() => store('keys_set', encoded)).then(() => undefined);
    // A failed key write poisons this session; caller closes it and restores from DB.
    writes = next;
    return next;
  };
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        await writes;
        const values = await store<Record<string, string>>('keys_get', {
          ids: ids.map((id) => `${type}:${id}`),
        });
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const value = values[`${type}:${id}`];
          if (!value) continue;
          const decoded = decode(`${type}:${id}`, value);
          result[id] =
            type === 'app-state-sync-key'
              ? proto.Message.AppStateSyncKeyData.fromObject(decoded)
              : decoded;
        }
        return result;
      },
      set: async (data) => {
        const records: Record<string, unknown> = {};
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values ?? {})) records[`${type}:${id}`] = value;
        }
        await save(records);
      },
    },
  };
  return { state, save: () => save({ creds: state.creds }), flush: () => writes };
}
