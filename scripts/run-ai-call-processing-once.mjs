// Runs the AI call-processing worker (transcription + summary + suggestions)
// once from this machine, the way trigger/minute-dispatch.ts runs it on
// Trigger.dev each minute. Use it for local and end-to-end runs while the
// Trigger.dev deployment is not running.
//
//   node --env-file=.env scripts/run-ai-call-processing-once.mjs [--rounds=5]
//
// Needs the same server-side environment as the worker: the Supabase service
// role, Tigris credentials, and Groq (GROQ_API_KEY, GROQ_TRANSCRIPTION_MODEL,
// GROQ_ANALYSIS_MODEL) unless the tenant has its own Groq connection. Claims at
// most two jobs per round and stops when the queue is empty.

import { createClient } from '@supabase/supabase-js';
import { runAiCallProcessing } from '../trigger/ai-call-processing.ts';

const rounds = Number(
  process.argv.find((argument) => argument.startsWith('--rounds='))?.split('=')[1] ?? 5,
);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
for (let round = 1; round <= rounds; round += 1) {
  const result = await runAiCallProcessing(supabase);
  console.log(`round ${round}: ${JSON.stringify(result)}`);
  if (result.claimed === 0) break;
}
