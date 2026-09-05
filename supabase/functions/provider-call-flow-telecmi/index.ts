import { decryptJson } from '../_shared/crypto.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { constantTimeEqual, type TelecmiCredential } from '../_shared/telecmi.ts';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

Deno.serve(async (request) => {
  if (!['POST', 'GET'].includes(request.method)) return json({ code: 405 }, 405);
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get('connection_id');
    const token = url.searchParams.get('token') ?? '';
    if (!connectionId || !token) return json({ code: 400 }, 400);
    const incoming =
      request.method === 'POST'
        ? ((await request.json()) as Record<string, unknown>)
        : Object.fromEntries(url.searchParams.entries());
    const admin = serviceClient();
    const { data: connection } = await admin
      .from('connected_accounts')
      .select('id,organization_id,connection_config')
      .eq('id', connectionId)
      .eq('provider_key', 'telecmi')
      .eq('status', 'CONNECTED')
      .is('deleted_at', null)
      .maybeSingle();
    if (!connection) return json({ code: 404 }, 404);
    const { data: secret } = await admin
      .from('integration_credentials')
      .select('encrypted_payload')
      .eq('organization_id', connection.organization_id)
      .eq('connected_account_id', connection.id)
      .maybeSingle();
    if (!secret) return json({ code: 404 }, 404);
    const credential = await decryptJson<TelecmiCredential>(secret.encrypted_payload);
    if (!constantTimeEqual(token, credential.webhook_secret)) return json({ code: 403 }, 403);
    if (Number(incoming.appid ?? incoming.app_id) !== credential.app_id)
      return json({ code: 403 }, 403);

    const config = (connection.connection_config ?? {}) as {
      inbound_route?: string;
      ivr_name?: string | null;
      team_name?: string | null;
      parallel_agents?: Array<{ user_id?: string; phone?: string }>;
    };
    if (config.inbound_route === 'IVR' && config.ivr_name)
      return json({ code: 200, action: 'ivr', name: config.ivr_name });
    if (config.inbound_route === 'TEAM' && config.team_name)
      return json({ code: 200, action: 'team', name: config.team_name });
    const agents = (config.parallel_agents ?? [])
      .filter((agent) => agent.user_id && agent.phone)
      .slice(0, 50)
      .map((agent) => ({ agent_id: agent.user_id, phone: agent.phone }));
    if (!agents.length) return json({ code: 200, hangup: true, result: [] });
    return json({
      code: 200,
      loop: 2,
      followme: false,
      hangup: false,
      timeout: 20,
      result: agents,
    });
  } catch {
    return json({ code: 500, hangup: true }, 500);
  }
});
