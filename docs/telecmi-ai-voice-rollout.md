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

## What a Client Admin configures

Every value below is entered once per connection in **Integrations → TeleCMI** and saved encrypted
against the connection's branch scope (`ONE_BRANCH`, `SELECTED_BRANCHES` or `ALL_BRANCHES`). The
browser never receives any of them back.

| Field                    | Where it comes from                        | Notes                                                    |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| App ID                   | TeleCMI dashboard → Developer → App Secret | Also stored as the connection's external account id      |
| App Secret               | same screen                                | Re-enter to rotate; the webhook secret survives rotation |
| TeleCMI account user ID  | TeleCMI user list                          | Format `extension_appid`, e.g. `101_2223012`             |
| Caller ID                | optional                                   | Digits only, no `+`                                      |
| Inbound web-flow action  | CRM choice                                 | `PARALLEL_USERS`, `IVR` or `TEAM`                        |
| IVR name                 | TeleCMI IVR list                           | Full name including app id, as `name@appid`              |
| Team name                | TeleCMI team list                          | Full name including app id, as `name_appid`              |
| Employee mobile mappings | created in the CRM or copied from TeleCMI  | `user_id` plus that employee's mobile                    |
| Live stereo audio stream | CRM choice                                 | Requires a `wss://` URL; applied to TeleCMI on save      |

Saving returns the CDR webhook URL and the HTTP call-flow URL. Both carry `connection_id` and a
per-connection `token`, which is the only authentication available because TeleCMI does not sign
webhook deliveries. Copy both into TeleCMI after the first save.

Agents can be created without leaving the CRM: `integration-telecmi-provision-agent` calls
TeleCMI's documented [user API](https://doc.telecmi.com/chub/docs/agent-add-agent/) with a
three-digit extension and returns the `extension_appid` mapping, which is the field admins most
often mistype. The softphone password is chosen by the admin and is never stored or echoed back.

## IP allowlisting

TeleCMI does not document an IP allowlist for its REST API, and the rejection shape for one is
therefore unverified. This matters because every TeleCMI request originates from a Supabase Edge
Function, which has **no stable egress IP** — an enforced allowlist cannot be satisfied by listing
addresses.

Leave the allowlist empty and verify empirically: the Integrations "Test connection" action calls
`/v2/analysis` over the same egress path as a real call. A `TELECMI_UNREACHABLE` or
`TELECMI_IP_NOT_ALLOWED` result points at network-level rejection, and `TELECMI_AUTH_REJECTED` at
the credentials themselves. If TeleCMI later confirms that an allowlist is enforced on the account,
TeleCMI traffic has to move behind a fixed-IP egress service before this integration is reliable.

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
