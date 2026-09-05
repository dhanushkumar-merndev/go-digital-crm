# TeleCMI calling and AI voice rollout

## Provider boundary

TeleCMI is the sole human telephony/IVR provider. The implementation follows TeleCMI's current
server APIs for [app authentication](https://doc.telecmi.com/chub/docs/app-auth/),
[click-to-call](https://doc.telecmi.com/chub/docs/click-to-call-admin/),
[HTTP call flow](https://doc.telecmi.com/chub/docs/http/),
[CDR webhooks](https://doc.telecmi.com/chub/docs/webhooks-overview/), and
[recording retrieval](https://doc.telecmi.com/chub/docs/play-record/).

The browser never receives the TeleCMI app secret. A website call creates an auditable CRM call
first, then an authenticated Edge Function asks TeleCMI to ring the configured agent and bridge the
customer. Inbound HTTP flow can return one IVR, one team, or a bounded parallel list of TeleCMI
agents.

TeleCMI's documented [streaming V3](https://doc.telecmi.com/chub/docs/streaming-v3/) is a one-way
audio stream to a dealership WebSocket. It is useful for live analytics, but it is not a documented
bidirectional voice-bot interface. AI voice calls therefore use a separate `AI_VOICE_GATEWAY_*`
adapter. Do not imply that TeleCMI performs the AI conversation unless a future verified TeleCMI
API explicitly supports it.

## Five-minute AI escalation

```text
Fresh lead assigned by ROUND_ROBIN
  -> durable job eligible at assignment + 5 minutes
  -> re-check current active assignment and lead state
  -> skip if human call exists, first contact exists, lead is DORMANT,
     telecaller/agent mapping is disabled, or assignment changed
  -> create AI call placeholder
  -> reserve AI credits atomically
  -> send branch-scoped context to AI voice gateway
  -> commit credits only after gateway accepts; otherwise reverse and retry
```

The Client Admin configures one AI voice agent per branch/team/telecaller using the audited
`upsert_ai_voice_agent` RPC. The delay is frozen at five minutes for this release. Agent
context contains only the customer/lead facts, branch name/address, currently available inventory,
and a constrained test-drive instruction. It never contains provider credentials.

The gateway request is server-to-server and uses an idempotency key. It must return:

```json
{ "accepted": true, "call_id": "provider-unique-call-id" }
```

The callback must include the configured timestamped HMAC-SHA256 signature and echo the CRM
`organization_id`, CRM `call_id`, and provider call ID. Terminal callbacks may include a short-lived
HTTPS recording URL. The worker validates its hostname against the configured allowlist, streams
the file directly to private Tigris storage, hashes it, then queues transcription and analysis.

## Recording, speakers, and approval

TeleCMI recordings and authorized Android manual-call recordings use the same private Tigris
pipeline. Uploads are presigned, MIME/size/checksum validated, and attached to an already-authorized
call. No large audio passes through Next.js.

Transcription and analysis are separate credit-bearing operations. Analysis produces ordered
`AGENT`, `CUSTOMER`, or `UNKNOWN` turns. Mixed mono Android recordings use AI-inferred speaker
separation, so uncertain identity must be `UNKNOWN`; stereo TeleCMI live-stream consumers may later
provide deterministic left/right separation using the documented
[stereo stream format](https://doc.telecmi.com/chub/docs/streaming-server/).

Extracted customer/lead facts are suggestions only. They enter the existing `ai_extraction_runs`
and `ai_field_reviews` workflow and do not modify Customer 360 until an authorized user explicitly
applies or edits each approved field. Interest, follow-up, lifecycle, temperature, and lost reason
remain distinct domain concepts.

## Rollout order

1. Apply migrations and deploy Edge Functions.
2. Set Edge/Trigger secrets listed in the deployment runbook.
3. Connect TeleCMI per tenant/branch and copy the returned CDR and HTTP-flow URLs into TeleCMI.
4. Verify one outbound website call, inbound parallel routing, CDR replay, and Tigris recording copy
   in staging.
5. Add AI credits, configure one telecaller AI agent, and run a controlled five-minute escalation.
6. Verify human-call suppression, `DORMANT` suppression, insufficient-credit behavior, retry/reversal,
   transcript speaker turns, and the Customer 360 approval gate.
7. Expand telecaller mappings and branches only after the controlled flow is audited.
