import { failure, preflight, requestId, success } from '../_shared/http.ts';
import {
  personalError,
  personalGateway,
  personalWhatsAppActor,
} from '../_shared/personal-whatsapp.ts';

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;
  const id = requestId(request);
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 'Use POST.', id, 405);
  try {
    const { client } = await personalWhatsAppActor(request);
    const input = await request.json();
    if (typeof input?.conversation_id !== 'string')
      throw new Error('PERSONAL_WHATSAPP_INVALID_MESSAGE');
    const { data, error } = await client.rpc('personal_whatsapp_sync_authorize', {
      target_conversation_id: input.conversation_id,
    });
    if (error) throw error;
    const result = await personalGateway('POST', '/v1/history', data);
    return success(result, id, 202);
  } catch (error) {
    return failure(personalError(error), 'Unable to request text history sync.', id, 409);
  }
});
