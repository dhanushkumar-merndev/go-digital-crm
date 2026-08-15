import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const allowedCommands = new Set(['build', 'config', 'env', 'init', 'submit']);
const argumentsToForward = process.argv.slice(2);
const command = argumentsToForward[0];

if (!allowedCommands.has(command)) {
  process.stderr.write(`EAS wrapper requires one of: ${[...allowedCommands].sort().join(', ')}.\n`);
  process.exitCode = 2;
} else {
  const result = spawnSync('pnpm', ['dlx', 'eas-cli@22.0.0', ...argumentsToForward], {
    cwd: resolve(import.meta.dirname, '../mobile'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`Unable to start EAS CLI: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
