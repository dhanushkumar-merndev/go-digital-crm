# TeleCMI connection SOP

Step-by-step procedure for connecting one TeleCMI account to the CRM and proving one outbound and
one inbound call end to end. Every field rule below is taken from the code that validates it, not
from the TeleCMI dashboard's own labels, because several CRM fields want a different shape than the
dashboard displays.

Companion documents: [telecmi-ai-voice-rollout.md](./telecmi-ai-voice-rollout.md) for the
architecture, [deployment-runbook.md](./deployment-runbook.md) for secrets and deploy order.

Performed by a **Client Admin**. No other role can open the TeleCMI provider form.

---

## 0. Pre-flight

Confirm all four before touching the TeleCMI dashboard. Steps 3 and 4 fail loudly and late if these
are wrong.

| Check                                                        | How                                                                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations applied                                           | `pnpm supabase:db:push`                                                                                                                                                                        |
| Edge Functions deployed                                      | `pnpm supabase:functions:deploy` — needs `integration-connect-telecmi`, `call-provider-start`, `provider-webhook-telecmi`, `provider-call-flow-telecmi`, `integration-telecmi-provision-agent` |
| `PUBLIC_EDGE_FUNCTION_BASE_URL` set in Supabase Edge secrets | Without it the connect call throws `PUBLIC_EDGE_FUNCTION_BASE_URL_MISSING` **after** saving, and you get no webhook URLs back                                                                  |
| `rest.telecmi.com` in `IVR_RECORDING_ALLOWED_HOSTS`          | Otherwise recordings are fetched but rejected at ingest                                                                                                                                        |

**Do not fill in the TeleCMI IP Whitelisting tab.** Every CRM request to TeleCMI originates from a
Supabase Edge Function, which has no stable egress IP. An enforced allowlist cannot be satisfied by
listing addresses and will break calling. Leave it empty.

---

## 1. Collect values from the TeleCMI dashboard

Open **Developer → App Secret**.

| CRM field               | Dashboard source   | Required shape                                                     |
| ----------------------- | ------------------ | ------------------------------------------------------------------ |
| App ID                  | App ID on the card | Digits only, e.g. `2223012`                                        |
| App Secret              | same card          | 8–512 chars                                                        |
| TeleCMI account user ID | user list          | `extension_appid`, e.g. `101_2223012` — **not** the bare extension |
| Caller ID               | your purchased DID | Digits only, **no `+`**, 8–15 digits                               |

### Caller ID is optional in the form but not optional in practice

If you leave Caller ID blank the CRM omits it from the call request and TeleCMI falls back to the
account default. What the customer sees is then whatever TeleCMI decides. **Always set it** — this
field is what makes the customer see the dealership number instead of a stray one, and it is the
entire number-masking guarantee.

---

## 2. Create the agents

One agent per telecaller who will place calls. Agents consume **extensions**, not phone numbers —
ten telecallers still need only the one DID from step 1.

Two routes, same result:

- **Create in TeleCMI** (in the CRM form): enter name, a **3–6 digit** extension, the employee's
  mobile, and a softphone password you choose. The CRM calls TeleCMI's user API and fills the
  returned `extension_appid` in for you. The password is never stored or echoed back — record it
  wherever you keep softphone credentials before you submit.
- **Add existing**: type the `user_id` and mobile by hand for an agent that already exists in the
  TeleCMI dashboard.

Extensions must be 3–6 digits. A duplicate returns `TELECMI_EXTENSION_TAKEN`.

### ⚠️ The mobile number must match the CRM profile digit-for-digit

This is the single most common cause of a first live call failing.

When a telecaller presses Call, the CRM matches **their own CRM profile phone** against the mapping
list to decide which TeleCMI agent to ring. The comparison strips every non-digit and then requires
an exact string match. It does **not** understand country codes.

So if the telecaller's CRM profile holds `+91 98765 43210`, the comparison value is
`919876543210`, and the mapping must be `919876543210`. Entering `9876543210` will **not** match,
and the call fails with `TELECMI_CALLER_MAPPING_NOT_CONFIGURED`.

Before step 3, open each telecaller's CRM profile, note exactly how their phone is stored, and use
the same digits in the mapping. There is no shared-agent fallback — an unmapped employee simply
cannot call.

---

## 3. Save the connection in the CRM

**Integrations → Add connection → TeleCMI IVR calling & recordings.**

1. **Display name** — 2–120 chars.
2. **Branch scope** — `ONE_BRANCH` (exactly one branch), `SELECTED_BRANCHES` (one or more), or
   `ALL_BRANCHES` (leave branches empty). For the first live test use `ONE_BRANCH`.
3. **App ID**, **App Secret**, **TeleCMI account user ID**, **Caller ID** from step 1.
4. **Inbound web-flow action** — for the first test choose `PARALLEL_USERS`. `IVR` additionally
   needs the IVR name as `name@appid`; `TEAM` needs the team name as `name_appid`. Both must
   include the app id or TeleCMI will not resolve them.
5. **Employee mobile mappings** — at least one, max 50. No duplicate user IDs or phones.
6. **Live stereo audio stream** — leave off for the first connection. Turning it on requires a
   `wss://` URL and is applied to your TeleCMI account immediately on save.

Save. The CRM tests the credentials against TeleCMI's `/v2/analysis` endpoint **before** storing
anything, so a save that succeeds is a credential that works.

---

## 4. Copy the two URLs back into TeleCMI

A successful save returns two authenticated endpoints. **Copy them now** — they carry a
per-connection token and the panel is the only place they are shown.

```
https://<project>.supabase.co/functions/v1/provider-webhook-telecmi?connection_id=…&token=…
https://<project>.supabase.co/functions/v1/provider-call-flow-telecmi?connection_id=…&token=…
```

- The **webhook URL** goes in TeleCMI under **Developer → Webhooks** as the CDR webhook.
- The **call-flow URL** goes in your TeleCMI inbound HTTP flow configuration.

That query-string token is the only authentication available, because TeleCMI does not sign its
webhook deliveries. Treat both URLs as secrets.

Rotating the App Secret later does **not** change the webhook token, so you do not have to re-paste
these URLs after a credential rotation.

---

## 5. Live test — outbound

1. Sign in as a telecaller whose mobile is mapped in step 2.
2. Open any lead with a phone number → **Call**.
3. Pick the connection in the dialog and start the call.

Expected sequence:

1. The telecaller's **own mobile rings first**, from TeleCMI.
2. On answer, TeleCMI dials the customer.
3. The customer's handset shows the **Caller ID from step 1**, never the telecaller's mobile.

Confirm in the CRM that a call row was created with status `PENDING`, then moved on via the CDR
webhook. If `record` was enabled on the TeleCMI account, a recording should land in private Tigris
storage shortly after the call ends.

Step 3 is the masking proof. If the customer sees the telecaller's personal mobile, the Caller ID
field was left blank — go back to step 1.

---

## 6. Live test — inbound

Call your DID from an outside phone.

With `PARALLEL_USERS`, TeleCMI requests the call-flow URL and the CRM answers with every mapped
agent. All their mobiles should ring **at once**, twice through the list, 20 seconds per attempt.
First to answer takes the call.

If no agents are mapped the CRM instructs TeleCMI to hang up — a silent disconnect on an inbound
call means an empty mapping list, not a network fault.

---

## 7. Troubleshooting

Every TeleCMI-facing operation reports the same vocabulary, so the code tells you which side failed.

| Code                                    | Meaning                                                    | Fix                                                                                             |
| --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `TELECMI_AUTH_REJECTED`                 | Wrong App ID or App Secret                                 | Re-copy both from Developer → App Secret                                                        |
| `TELECMI_UNREACHABLE`                   | TeleCMI did not answer at all                              | Network-level block. If your account enforces an IP allowlist, Edge Functions cannot satisfy it |
| `TELECMI_IP_NOT_ALLOWED`                | TeleCMI explicitly refused the server                      | Clear the IP allowlist on the TeleCMI account                                                   |
| `TELECMI_INSUFFICIENT_BALANCE`          | TeleCMI account out of credit                              | Top up                                                                                          |
| `TELECMI_EXTENSION_TAKEN`               | Extension already exists                                   | Pick another extension                                                                          |
| `TELECMI_CALLER_MAPPING_NOT_CONFIGURED` | Signed-in user's profile phone matches no mapping          | See the digit-matching warning in step 2                                                        |
| `CALL_PROVIDER_SCOPE_DENIED`            | Lead's branch is outside the connection's scope            | Widen the connection scope or use the right connection                                          |
| `BRANCH_SCOPE_DENIED`                   | Admin's authority is narrower than the chosen scope        | Use an admin with the right branch authority                                                    |
| `PROVIDER_CALL_REQUEST_IN_PROGRESS`     | Duplicate request id replayed while the first is in flight | Wait and retry                                                                                  |

Use **Test connection** on the Integrations panel to separate credential problems from network
problems without placing a call — it hits `/v2/analysis` over the same egress path a real call uses.

---

## 8. After the first successful pair of calls

Only once both live tests pass:

1. Add the remaining telecaller mappings, checking each profile phone against its mapping.
2. Add further branches, or a second connection with its own Caller ID if each showroom should
   display its own local number.
3. Switch inbound to `IVR` or `TEAM` if parallel ringing is not the desired routing.
4. Enable the stereo stream only when a `wss://` consumer is actually running.

AI voice calling is a **separate** rollout and is not enabled by this procedure. It requires an AI
voice gateway that does not exist yet; TeleCMI does not perform the AI conversation. See
[telecmi-ai-voice-rollout.md](./telecmi-ai-voice-rollout.md).
