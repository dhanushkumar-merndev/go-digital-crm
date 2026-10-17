import { z } from 'npm:zod@4';
import { aiAgentJson, aiAgentRpcFailure, readSignedAiAgentBody } from '../_shared/ai-agent.ts';
import { serviceClient } from '../_shared/supabase.ts';

// The voice agent asks for one call's script and lead context when PIOPIY
// hands it the call. Only the CRM call id and context token travel through
// TeleCMI; the customer details come from here, and only while the call is open.

const schema = z.object({
  call_id: z.uuid(),
  context_token: z.string().regex(/^[a-f0-9]{64}$/),
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
    const { data, error } = await serviceClient().rpc('get_auto_ai_call_context', {
      target_call_id: parsed.data.call_id,
      target_context_token: parsed.data.context_token,
    });
    if (error) return aiAgentRpcFailure(error);
    return aiAgentJson(200, { code: 'OK', context: data });
  } catch {
    return aiAgentJson(500, { code: 'AI_AGENT_REQUEST_FAILED' });
  }
});
