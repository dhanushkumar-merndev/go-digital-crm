# Fix: TeleCMI "Connection was not saved — TeleCMI rejected the request."

## Symptom

Saving a TeleCMI connection in **Integrations → Add connection → TeleCMI IVR calling &
recordings** always fails. The dialog shows:

> Could not save changes. Please review the details and try again.
> Connection was not saved. TeleCMI rejected the request.

This happens with valid credentials. It is not a user input problem — no value entered in that
form can make the save succeed.

Reproduced against a real India TeleCMI account (App ID `33338826`, agents `5001_33338826` and
`5002_33338826`).

---

## Root cause

`testTelecmiCredential` calls TeleCMI's analysis API without the two date parameters the API
requires.

`supabase/functions/_shared/telecmi.ts:93`

```ts
export async function testTelecmiCredential(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
) {
  await telecmiJson<{ total?: number; answered?: number; missed?: number }>('/v2/analysis', {
    appid: credential.app_id,
    secret: credential.app_secret,
  });
}
```

Per TeleCMI's documentation, `/v2/analysis` requires **four** parameters: `appid`, `secret`,
`start_date`, `end_date` — the last two being epoch timestamps in **milliseconds**.

Because the dates are missing, TeleCMI answers with a body whose `code` is not `200`.
`telecmiJson` treats that as a failure:

`supabase/functions/_shared/telecmi.ts:83`

```ts
if (!response.ok || !payload || payload.code !== 200 || payload.error)
```

`classifyTelecmiFailure` then finds no matching signal (no `ip`/`balance`/`extension` keyword, and
the HTTP status is 200 rather than 401/403), so it returns the catch-all `TELECMI_REQUEST_REJECTED`,
which `describeTelecmiFailure` renders as the generic *"TeleCMI rejected the request."*

The connect Edge Function runs this test **before** persisting anything, so the whole save is
rejected.

### Why this blocks every save

`testTelecmiCredential` is the gate on the connect path. Until it can return successfully, no
TeleCMI connection can ever be stored, for any account, in any region.

---

## Change 1 — send the required dates (this is the actual fix)

In `supabase/functions/_shared/telecmi.ts`, replace `testTelecmiCredential`:

```ts
export async function testTelecmiCredential(
  credential: Pick<TelecmiCredential, 'app_id' | 'app_secret'>,
) {
  // /v2/analysis rejects a request that omits the window, so the credential
  // probe asks for a narrow recent one. The counts are discarded -- reaching a
  // 200 at all is the only signal this needs.
  const endDate = Date.now();
  const startDate = endDate - 86_400_000;
  await telecmiJson<{ total?: number; answered?: number; missed?: number }>('/v2/analysis', {
    appid: credential.app_id,
    secret: credential.app_secret,
    start_date: startDate,
    end_date: endDate,
  });
}
```

Both values must be **numbers in milliseconds**, not ISO strings and not seconds.

---

## Change 2 — accept extensions longer than three digits

The production India account issues **four-digit** extensions (`5001`, `5002`), but the code hard-
rejects anything that is not exactly three digits. This makes the "Create in TeleCMI" button
unusable on that account, and the failure message actively misleads the admin by telling them to
pick a different *three-digit* extension.

Three places assert the three-digit rule:

**a. `supabase/functions/_shared/telecmi.ts:172`**

```ts
export function normalizeTelecmiExtension(value: string | number) {
  const digits = String(value).trim();
  // TeleCMI issues three-digit extensions and derives the agent id from them.
  if (!/^\d{3}$/.test(digits)) throw new Error('TELECMI_EXTENSION_INVALID');
  return Number(digits);
}
```

Change the pattern to `/^\d{3,6}$/` and update the comment — extension length varies per TeleCMI
account, it is not a fixed platform rule.

**b. `supabase/functions/integration-telecmi-provision-agent/index.ts:18`**

```ts
extension: z
  .string()
  .trim()
  .regex(/^\d{3}$/),
```

Change to `/^\d{3,6}$/` to match.

**c. `supabase/functions/_shared/telecmi.ts:247`** — the `TELECMI_EXTENSION_TAKEN` message says
"Choose a different three-digit extension." Drop "three-digit".

**d. UI copy, `src/features/integrations/telecmi-agent-editor.tsx:176`**

```
Three digits. TeleCMI builds the user ID as extension_appid.
```

Change to something like "3–6 digits. TeleCMI builds the user ID as extension_appid."

Note `normalizeTelecmiUserId` already accepts these — its pattern is `^\d{1,12}_\d{1,12}$`, so
`5001_33338826` passes today. Only the *create* path is over-constrained; "Add existing" already
works.

---

## Change 3 — stop swallowing TeleCMI's error text

Diagnosing this took a doc dive because the provider's own `msg` and `code` are captured and then
discarded. `TelecmiError` already carries `httpStatus` and `providerCode`, but
`describeTelecmiFailure`'s default branch returns a fixed string and the `msg` is never stored at all.

In `telecmiJson`, keep the provider message on the error, and in the `default` branch of
`describeTelecmiFailure` include the provider code and message in the returned `message`. Keep it to
the provider's own words — do not interpolate the App Secret or any request body into it.

This is optional for the fix but turns the next failure of this kind into a one-line diagnosis
rather than an investigation.

---

## Do NOT do this

While diagnosing, TeleCMI's India documentation surfaces a parallel API on a different host:

| | Current code (correct) | India doc variant |
|---|---|---|
| Host | `rest.telecmi.com` | `piopiy.telecmi.com` |
| Analysis | `/v2/analysis` | `/v1/analysis` |
| Add agent | `/v2/user/add` | `/v1/agent/add` |
| Click to call | `/v2/webrtc/click2call` | `/v1/agentConnect` |

**Do not migrate to those endpoints.** They authenticate with a *per-agent user login token*
obtained from a separate login call, not with `appid` + `secret`. This integration has no such
token, stores no such token, and `/v1/agentConnect` exposes no `callerid` parameter — adopting it
would silently destroy the number-masking guarantee that the Caller ID field exists to provide.

The endpoint the code already uses, `/v2/webrtc/click2call`, is TeleCMI's **Click-To-Call Admin**
API: it authenticates with `user_id` + `secret`, and supports `callerid`, `followme`, `webrtc` and
`extra_params` — exactly the model this integration is built on. Its documentation uses an India
phone number in its own example, so it is not region-restricted.

Keep the host and all paths as they are. Only the missing dates are wrong.

---

## Verification

1. **Direct API check** (fastest, proves the fix independently of the app). With a real App
   Secret:

   ```
   curl -s -X POST https://rest.telecmi.com/v2/analysis \
     -H 'content-type: application/json' \
     -d '{"appid":33338826,"secret":"<full-secret>","start_date":1757980800000,"end_date":1758067200000}'
   ```

   Expect `{"code":200,"total":…,"answered":…,"missed":…}`. If this returns 200 but the app still
   fails, the fix above is incomplete. If this itself fails, the credentials are genuinely wrong
   and the app is behaving correctly.

2. **Deploy and save.** `pnpm supabase:functions:deploy`, then re-open the connect dialog with the
   same values and save. It should succeed and return the webhook + call-flow URLs.

3. **Extension fix.** With the connection saved, open "Create in TeleCMI" and enter a free
   four-digit extension. It should be accepted rather than rejected.

4. Do not regress the existing behaviour that the credential test runs **before** anything is
   persisted — a failing test must still leave no connection row behind.

---

## Files to change

| File | Change |
|---|---|
| `supabase/functions/_shared/telecmi.ts` | Change 1 (required), Change 2a/2c, Change 3 (optional) |
| `supabase/functions/integration-telecmi-provision-agent/index.ts` | Change 2b |
| `src/features/integrations/telecmi-agent-editor.tsx` | Change 2d |

Also worth updating `docs/telecmi-connect-sop.md`, which currently states "Extensions must be
exactly three digits" as a TeleCMI fact. It is our own constraint, and the India account
contradicts it.
