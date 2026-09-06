import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configurationProblems,
  initializeLocalSecrets,
  loadLocalEnvironment,
  probeDatabase,
} from '../../services/whatsapp-gateway/scripts/local.mjs';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crm-whatsapp-local-test-'));
  directories.push(root);
  await mkdir(join(root, 'services/whatsapp-gateway'), { recursive: true });
  await writeFile(
    join(root, '.env'),
    'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=private-test-service-key\nUNRELATED_PROVIDER_SECRET=must-not-copy\n',
  );
  return root;
}
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('local WhatsApp development runner', () => {
  it('loads only gateway configuration and binds to loopback', async () => {
    const env = await loadLocalEnvironment(await fixture(), {});
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('private-test-service-key');
    expect(env).not.toHaveProperty('UNRELATED_PROVIDER_SECRET');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PERSONAL_WHATSAPP_MAX_SESSIONS).toBe('1');
  });
  it('creates independent private secrets without modifying root env or rotating on a repeat', async () => {
    const root = await fixture();
    const original = await readFile(join(root, '.env'), 'utf8');
    expect(await initializeLocalSecrets(root, {})).toBe(true);
    const env = await loadLocalEnvironment(root, {});
    expect(configurationProblems(env)).toEqual([]);
    expect(env.PERSONAL_WHATSAPP_ENCRYPTION_KEY).not.toBe(env.PERSONAL_WHATSAPP_SIGNING_SECRET);
    expect(await initializeLocalSecrets(root, {})).toBe(false);
    expect(await loadLocalEnvironment(root, {})).toEqual(env);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(original);
    expect((await stat(join(root, 'services/whatsapp-gateway/.env.local'))).mode & 0o777).toBe(
      0o600,
    );
  });
  it('never places service-role or unrelated provider secrets in the generated file', async () => {
    const root = await fixture();
    await initializeLocalSecrets(root, {});
    const content = await readFile(join(root, 'services/whatsapp-gateway/.env.local'), 'utf8');
    expect(content).not.toContain('private-test-service-key');
    expect(content).not.toContain('UNRELATED_PROVIDER_SECRET');
  });
  it('respects explicit runtime configuration without allowing a LAN bind', async () => {
    const env = await loadLocalEnvironment(await fixture(), { PORT: '12345', HOST: '0.0.0.0' });
    expect(env.PORT).toBe('12345');
    expect(env.HOST).toBe('127.0.0.1');
  });
  it('rejects insecure remote database URLs and invalid key/capacity values', async () => {
    const root = await fixture();
    await initializeLocalSecrets(root, {});
    const env = await loadLocalEnvironment(root, {});
    expect(
      configurationProblems({
        ...env,
        SUPABASE_URL: 'http://example.com',
        PERSONAL_WHATSAPP_MAX_SESSIONS: '6',
        PERSONAL_WHATSAPP_ENCRYPTION_KEY: 'invalid',
      }),
    ).toEqual(
      expect.arrayContaining([
        'SUPABASE_URL_INVALID',
        'PERSONAL_WHATSAPP_MAX_SESSIONS_INVALID',
        'PERSONAL_WHATSAPP_ENCRYPTION_KEY_INVALID',
      ]),
    );
    expect(configurationProblems({ ...env, SUPABASE_URL: 'http://127.0.0.1:54321' })).toEqual([]);
  });
  it('probes tables with read-only empty-result requests and does not return response bodies', async () => {
    const env = await loadLocalEnvironment(await fixture(), {});
    const request = vi.fn(async () => new Response('private response context', { status: 404 }));
    const results = await probeDatabase(env, request);
    expect(results).toHaveLength(4);
    expect(
      results.every(
        (row: { resource: string; ready: boolean; status: number | string }) =>
          !row.ready && row.status === 404,
      ),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain('private response context');
    for (const call of request.mock.calls as unknown as [URL, RequestInit][]) {
      expect(call[0].searchParams.get('limit')).toBe('0');
      expect(call[1].method).toBe('GET');
      expect(call[1].redirect).toBe('error');
    }
  });
  it('reports network failures without reflecting secret-bearing errors', async () => {
    const env = await loadLocalEnvironment(await fixture(), {});
    const results = await probeDatabase(env, async () => {
      throw new Error('SECRET');
    });
    expect(
      results.every(
        (row: { resource: string; ready: boolean; status: number | string }) =>
          row.status === 'UNREACHABLE',
      ),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain('SECRET');
  });
});
