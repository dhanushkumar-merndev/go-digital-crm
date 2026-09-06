import { failure, preflight, requestId, success } from '../_shared/http.ts';
import {
  personalError,
  personalGateway,
  personalWhatsAppActor,
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
    const { data, error } = await serviceClient().rpc('personal_whatsapp_link_authorize', {
      target_actor: userId,
      target_org: organizationId,
    });
    if (error) throw error;
    try {
      await personalGateway('POST', '/v1/sessions', data);
    } catch {
      return success({ ...data, status: 'CONNECTING', gateway_pending: true }, id, 202);
    }
    return success({ ...data, status: 'CONNECTING' }, id, 202);
  } catch (error) {
    return failure(personalError(error), 'Unable to link personal WhatsApp.', id, 409);
  }
});
