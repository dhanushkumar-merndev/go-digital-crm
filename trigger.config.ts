import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  // Keep the checked-in default aligned with the shared production project.
  // Local/staging environments can still override this through TRIGGER_PROJECT_REF.
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_fzoptcxghjglrrhbqzql',
  dirs: ['./trigger'],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 5,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
