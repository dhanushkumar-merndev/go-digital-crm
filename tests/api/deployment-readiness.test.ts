import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('production deployment contracts', () => {
  it('pins supported runtimes and the package manager', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      engines: { node: string; pnpm: string };
      packageManager: string;
    };
    expect(read('.nvmrc').trim()).toBe('24.18.0');
    expect(read('.dvmrc').trim()).toBe('2.9.5');
    expect(packageJson.engines).toEqual({ node: '24.x', pnpm: '11.21.0' });
    expect(packageJson.packageManager).toBe('pnpm@11.21.0');
  });

  it('keeps CI on API/backend checks and covers each build boundary', () => {
    const workflow = read('.github/workflows/ci.yml');
    for (const command of [
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm typecheck:mobile',
      'pnpm mobile:doctor',
      'pnpm test:api',
      'pnpm build:webpack',
      'deno check',
      'supabase db reset',
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).not.toMatch(/playwright|cypress|test:e2e|test:ui/i);
  });

  it('validates production web configuration before Vercel builds', () => {
    const vercel = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    expect(vercel.framework).toBe('nextjs');
    expect(vercel.installCommand).toBe('pnpm install --frozen-lockfile');
    expect(vercel.buildCommand).toBe('pnpm build:vercel');
    expect(vercel).not.toHaveProperty('crons');
    expect(vercel).not.toHaveProperty('env');
  });

  it('uses isolated EAS preview and production environments without embedded values', () => {
    const eas = JSON.parse(read('mobile/eas.json')) as {
      build: Record<string, Record<string, unknown>>;
    };
    expect(eas.build.preview.environment).toBe('preview');
    expect(eas.build.preview.distribution).toBe('internal');
    expect(eas.build.production.environment).toBe('production');
    expect(eas.build.production.autoIncrement).toBe(true);
    expect(JSON.stringify(eas)).not.toMatch(/SUPABASE_|EXPO_PUBLIC_|SERVICE_ROLE|SECRET/);
  });

  it('keeps the committed environment template structurally safe', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/validate-env.mjs', '--target', 'example'], {
        cwd: root,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
