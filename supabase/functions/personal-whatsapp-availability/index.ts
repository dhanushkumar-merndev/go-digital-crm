import { failure, preflight, requestId, success } from '../_shared/http.ts';
import { checkPersonalGateway, personalWhatsAppActor } from '../_shared/personal-whatsapp.ts';

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;
  const id = requestId(request);
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 'Use POST.', id, 405);
  try {
    const { client } = await personalWhatsAppActor(request);
    const [status] = await Promise.all([
      client.rpc('get_personal_whatsapp_status', { target_conversation_id: null }),
      checkPersonalGateway(),
    ]);
    if (status.error) throw status.error;
    return success({ available: true, status: status.data }, id);
  } catch {
    return failure(
      'PERSONAL_WHATSAPP_GATEWAY_UNAVAILABLE',
      'WhatsApp is unavailable. Try again shortly.',
      id,
      503,
    );
  }
});
