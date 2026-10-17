import { z } from 'npm:zod@4';
import { aiAgentJson, aiAgentRpcFailure, readSignedAiAgentBody } from '../_shared/ai-agent.ts';
import { dialNextAutoCalls } from '../_shared/auto-call.ts';
import { serviceClient } from '../_shared/supabase.ts';

// The voice agent's end-of-call report: outcome, summary, the answers it heard
// and the transcript. The answers only become suggestions the telecaller
// reviews; the database drops any field or value it does not accept. A repeat
// post for the same call is acknowledged as replayed.

const outcome = z.enum([
  'ANSWERED_QUALIFIED',
  'CALLBACK_REQUESTED',
  'NOT_INTERESTED',
  'DO_NOT_CALL',
  'WRONG_NUMBER',
  'NO_RESPONSE',
  'VOICEMAIL',
  'FAILED',
]);

const answerValue = z.union([z.string().trim().min(1).max(120), z.number().finite(), z.boolean()]);

const schema = z.object({
  call_id: z.uuid(),
  context_token: z.string().regex(/^[a-f0-9]{64}$/),
  outcome,
  language: z.enum(['en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN']).nullable().optional(),
  summary: z.string().trim().max(4000).nullable().optional(),
  answers: z.record(z.string().regex(/^[a-z_]{2,40}$/), answerValue).optional(),
  turns: z
    .array(
      z.object({
        speaker: z.enum(['AGENT', 'CUSTOMER']),
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .max(400)
    .optional(),
  duration_seconds: z.number().int().min(0).max(86_400).nullable().optional(),
});

Deno.serve(async (request) => {
  if (request.method !== 'POST') return aiAgentJson(405, { code: 'METHOD_NOT_ALLOWED' });
  try {
    const rawBody = await readSignedAiAgentBody(request);
    if (rawBody === null) return aiAgentJson(401, { code: 'INVALID_SIGNATURE' });
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return aiAgentJson(400, { code: 'INVALID_JSON' });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return aiAgentJson(422, { code: 'INVALID_PAYLOAD' });
    const input = parsed.data;
    const admin = serviceClient();
    const { data, error } = await admin.rpc('record_auto_ai_call_result', {
      target_call_id: input.call_id,
      target_context_token: input.context_token,
      target_outcome: input.outcome,
      target_language: input.language ?? null,
      target_summary: input.summary ?? null,
      target_answers: input.answers ?? {},
      target_turns: input.turns ?? [],
      target_duration_seconds: input.duration_seconds ?? null,
    });
    if (error) return aiAgentRpcFailure(error);
    const result = data as { replayed?: boolean; answered?: boolean };
    // The telecaller's next lead is dialled now rather than at the next minute.
    if (!result.replayed)
      await dialNextAutoCalls(admin, `ai-agent-result:${input.call_id}`, 5).catch(() => null);
    return aiAgentJson(200, {
      code: result.replayed ? 'REPLAYED' : 'RECORDED',
      answered: result.answered ?? false,
    });
  } catch {
    return aiAgentJson(500, { code: 'AI_AGENT_REQUEST_FAILED' });
  }
});
