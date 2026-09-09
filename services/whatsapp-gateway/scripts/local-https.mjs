import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { configurationProblems, loadLocalEnvironment, probeDatabase } from './local.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = resolve(packageDirectory, '../..');

function extractProjectRef(supabaseUrl) {
  try {
    const url = new URL(supabaseUrl);
    const hostParts = url.hostname.split('.');
    if (hostParts.length >= 3 && url.hostname.endsWith('.supabase.co')) {
      return hostParts[0];
    }
  } catch {
    // fallback
  }
  return 'yzplfphnpoksvcetwhad';
}

async function waitForGateway(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.ok === true) return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('GATEWAY_HEALTH_TIMEOUT');
}

function startTunnel(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cloudflared = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-tls-verify'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        cloudflared.kill('SIGTERM');
        rejectPromise(new Error('TUNNEL_TIMEOUT'));
      }
    }, 30_000);

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolvePromise({ url: match[0], process: cloudflared });
      }
    };

    cloudflared.stdout.on('data', onData);
    cloudflared.stderr.on('data', onData);

    cloudflared.on('error', (err) => {
      if (!resolved) {
        clearTimeout(timeout);
        rejectPromise(err);
      }
    });

    cloudflared.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        rejectPromise(new Error(`TUNNEL_EXITED_${code}`));
      }
    });
  });
}

async function syncSupabaseSecrets(projectRef, gatewayUrl, signingSecret) {
  console.log(`Syncing secrets to Supabase project [${projectRef}]...`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'pnpm',
      [
        'dlx',
        'supabase@2.114.0',
        'secrets',
        'set',
        `PERSONAL_WHATSAPP_GATEWAY_URL=${gatewayUrl}`,
        `PERSONAL_WHATSAPP_SIGNING_SECRET=${signingSecret}`,
        '--project-ref',
        projectRef,
      ],
      { cwd: repositoryDirectory, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('Supabase Edge Function secrets updated successfully.');
        resolvePromise(true);
      } else {
        console.error('Failed to update Supabase secrets:', output);
        rejectPromise(new Error(`SECRETS_SET_FAILED_${code}`));
      }
    });
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('NODE_24_OR_NEWER_REQUIRED');
  }

  const env = await loadLocalEnvironment();
  const problems = configurationProblems(env);
  if (problems.length) {
    console.error('Configuration problems detected:', problems.join(', '));
    process.exitCode = 1;
    return;
  }

  const readiness = await probeDatabase(env);
  const ready = readiness.length === 4 && readiness.every((r) => r.ready);
  if (!ready) {
    console.error('Database tables not ready. Check personal_whatsapp tables.');
    process.exitCode = 1;
    return;
  }

  const port = env.PORT || 10000;
  console.log(`Starting WhatsApp Gateway process on port ${port}...`);

  const gatewayProcess = spawn(process.execPath, [resolve(packageDirectory, 'dist/index.js')], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  const cleanup = () => {
    console.log('\nShutting down WhatsApp Gateway and HTTPS tunnel...');
    try {
      gatewayProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    try {
      if (tunnel?.process) tunnel.process.kill('SIGTERM');
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  gatewayProcess.on('error', (err) => {
    console.error('Gateway process error:', err);
    cleanup();
    process.exit(1);
  });

  gatewayProcess.on('exit', (code) => {
    console.log(`Gateway process exited with code ${code}`);
    cleanup();
    process.exit(code ?? 0);
  });

  console.log('Waiting for Gateway health check...');
  await waitForGateway(`http://127.0.0.1:${port}/health`);
  console.log('Gateway is healthy.');

  console.log('Starting Cloudflare HTTPS tunnel...');
  let tunnel;
  try {
    tunnel = await startTunnel(port);
  } catch (err) {
    console.error('Failed to establish HTTPS tunnel:', err);
    cleanup();
    process.exit(1);
  }

  console.log(`HTTPS Tunnel established: ${tunnel.url}`);

  const projectRef = extractProjectRef(env.SUPABASE_URL);
  await syncSupabaseSecrets(projectRef, tunnel.url, env.PERSONAL_WHATSAPP_SIGNING_SECRET);

  console.log('\n======================================================');
  console.log('🟢 WhatsApp Service is LIVE & WORKABLE in HTTPS!');
  console.log('======================================================');
  console.log(`Local Gateway:   http://127.0.0.1:${port}/health`);
  console.log(`Public HTTPS:    ${tunnel.url}`);
  console.log(`Supabase Edge:   Linked & Configured (${projectRef})`);
  console.log('======================================================');
  console.log('Keep this process running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
