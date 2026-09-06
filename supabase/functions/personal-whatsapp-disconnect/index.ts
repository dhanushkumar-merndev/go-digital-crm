import { z } from 'npm:zod@4';
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
    const input = z.object({ connection_id: z.uuid() }).parse(await request.json());
    // Revocation is committed before the network call; a dead gateway cannot preserve access.
    const { error } = await client.rpc('personal_whatsapp_disconnect', {
      target_connection_id: input.connection_id,
    });
    if (error) throw error;
    try {
      await personalGateway('DELETE', `/v1/sessions/${input.connection_id}`);
    } catch {
      /* Heartbeat fences the old generation; ask the owner to unlink on their phone too. */
    }
    return success({ disconnected: true }, id);
  } catch (error) {
    return failure(personalError(error), 'Unable to disconnect personal WhatsApp.', id, 409);
  }
});
