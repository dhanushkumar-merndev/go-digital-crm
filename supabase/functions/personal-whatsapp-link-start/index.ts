import { failure, preflight, requestId, success } from '../_shared/http.ts';
import {
  personalError,
  personalGateway,
  personalWhatsAppActor,
  checkPersonalGateway,
} from '../_shared/personal-whatsapp.ts';
import { serviceClient } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const cors = preflight(request);
  if (cors) return cors;
  const id = requestId(request);
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 'Use POST.', id, 405);
  try {
    const { userId, organizationId } = await personalWhatsAppActor(request);
    const input = await request.json();
    if (input?.consent_version !== 'pilot-v1')
      throw new Error('PERSONAL_WHATSAPP_CONSENT_REQUIRED');
    if (
      !Deno.env.get('PERSONAL_WHATSAPP_GATEWAY_URL') ||
      !Deno.env.get('PERSONAL_WHATSAPP_SIGNING_SECRET')
    )
      throw new Error('PERSONAL_WHATSAPP_NOT_CONFIGURED');
    await checkPersonalGateway();
    const { data, error } = await serviceClient().rpc('personal_whatsapp_link_authorize', {
      target_actor: userId,
      target_org: organizationId,
    });
    if (error) throw error;
    try {
      // Linking or resuming is someone at the CRM right now: online.
      await personalGateway('POST', '/v1/sessions', { ...data, online: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'PERSONAL_WHATSAPP_CAPACITY') {
        // Every socket belongs to someone online. A new link is cancelled and
        // an existing one waits as BUSY; either way the user tries again later.
        await serviceClient().rpc('personal_whatsapp_capacity_wait', {
          target_connection_id: data.connection_id,
          target_generation: data.generation,
        });
        return failure(
          'PERSONAL_WHATSAPP_CAPACITY',
          'WhatsApp server is busy. Try again in a few minutes.',
          id,
          503,
        );
      }
      return success({ ...data, status: 'CONNECTING', gateway_pending: true }, id, 202);
    }
    return success({ ...data, status: 'CONNECTING' }, id, 202);
  } catch (error) {
    return failure(personalError(error), 'Unable to link personal WhatsApp.', id, 409);
  }
});
