# Personal WhatsApp pilot

Independently deployed Node 24 service. Supabase owns authorization, CRM records,
encrypted authentication keys, send reservations and socket leases. This package
owns only the long-lived Baileys sockets. No Next.js business API or monorepo
framework is introduced.

This is an unofficial, experimental linked-device integration. Limits do **not**
make it ban-proof. Use an approved Meta integration for production reliability.
The official WhatsApp Cloud API integration remains separate and unchanged.

## Deployment

1. Review/apply `supabase/migrations/202609060001_personal_whatsapp_pilot.sql` after
   the preceding migrations. Back up the target database before deployment.
2. Deploy the `personal-whatsapp-link-start`, `personal-whatsapp-disconnect` and
   updated `send-message` Supabase Edge Functions. Keep JWT verification enabled.
3. Create a Render Blueprint from the repository's `render.yaml`. It builds this
   package and runs it as a Free Web Service. Configure secrets in Render, never
   commit a real `.env`. The example in this directory lists the required names.
4. Supply `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only on the gateway.
   Generate two **independent** random secrets using your password/secret manager:
   a 32-byte base64 `PERSONAL_WHATSAPP_ENCRYPTION_KEY` and a signing secret of at
   least 32 random bytes. Keep a secure backup of the encryption key; losing or
   replacing it requires revoking the old connections and scanning again.
5. Set Supabase Edge secrets `PERSONAL_WHATSAPP_GATEWAY_URL` to the Render HTTPS
   origin (no path/query) and `PERSONAL_WHATSAPP_SIGNING_SECRET` to the same signing
   secret as Render. The encryption key must **not** be installed in the browser,
   mobile app or Edge Functions. None of these secrets are `NEXT_PUBLIC_*`.
6. Deploy the web app. An eligible Telecaller or Sales Consultant with both
   `message.view` and `message.send` can open **Connect my WhatsApp** in the inbox,
   acknowledge the risk/privacy notice, then scan using WhatsApp Linked devices.
7. Once the public Render URL exists, create an UptimeRobot HTTP monitor for
   `https://YOUR-SERVICE.onrender.com/health`, interval **10 minutes**, and configure
   failure notifications. This setup is manual and has not been provisioned by
   the code. Monitor requests cannot guarantee uptime or prevent suspension.

The repository does not contain deployed credentials or a provisioned Render URL.
Do not run migration resets against a live CRM or use a production personal number
for an unreviewed test.

## Scope and safety

- Hard database cap: five enabled linked/recently linking accounts across this
  Supabase deployment, not five per tenant. The process also refuses new sockets
  at five accounts or 70% of its configured 512 MB RSS budget. Five accounts is a
  pilot ceiling, **not measured throughput or a memory guarantee**.
- One socket owner at a time: a process-generated UUID, 45-second lease,
  10-second heartbeat and generation fence prevent stale processes from writing.
  Restoration is sequential; expired/unavailable sockets recover on a bounded
  30-second reconciliation cycle.
- Only text messages matching exactly one accessible CRM identity are
  stored. Unmatched, inaccessible and ambiguous conversations are discarded;
  phone matches never merge customers. Opaque WhatsApp LIDs without an explicit
  phone alternative are discarded. Groups, media, status and private ephemeral
  payloads are ignored. No media download or contact harvesting occurs.
- Available offline/initial history is imported automatically, limited to the last
  30 days and 1,000 messages per provider batch. History has no guessed lead assignment.
  The authenticated Sync text history action requests up to 100 older messages for
  one existing conversation, at most once per minute. It requires a stored message
  anchor and a connected phone; WhatsApp may return no history. This is a request,
  not a guarantee of complete chat recovery. Deploy the text-history migration,
  personal-whatsapp-sync Edge Function, gateway, and web UI together.
- Personal messages use dedicated owner-only tables, unioned into the shared
  inbox. Legacy manager/Customer 360 reports cannot accidentally include them.
  Session keys and QR storage have no browser table grants. The owner status RPC
  masks the number and removes expired QR values at read time. QR query caching
  is nonpersistent and cleared when the dialog closes.
- Browser session expiry does not invent a background login: worker scope checks
  use the employee's current active role, permissions and branch/record access.
  Browser reads and human send requests still require normal session/MFA checks.
- Human-triggered text messages in existing CRM conversations, including before
  an inbound reply and after 24 hours. No inbound-message window is required. Maximum
  1,500 characters; one send per five seconds, ten per ten minutes, fifty per
  rolling day, twenty per recipient per rolling day, one unresolved send/account.
  Reservations count even if a send later fails. No campaign, schedule, template,
  bulk action or automation path is connected to this adapter.
- Three failed/uncertain provider sends within ten minutes pause CRM sending for
  thirty minutes. An uncertain send is never automatically resent. The employee
  checks their phone and explicitly acknowledges uncertainty before another send.
  A provider message ID is reserved before network I/O; receipts/phone echoes
  reconcile it idempotently. WhatsApp-phone-originated messages cannot be limited.
- Auth/Signal keys are AES-256-GCM encrypted separately with connection/key AAD.
  Frequently rotated Signal keys are upserted independently, not as one giant
  credential blob. Signed endpoints include method/path/body/timestamp/nonce;
  nonces are persisted to reject replay after a process restart.
- Provider logs are suppressed because upstream dependencies may print session
  material. `/health` exposes only `{ "ok": true/false }`; never add number,
  connection IDs, QR values, message bodies or decrypted auth state to logs.

## Operations and verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @go-digital/whatsapp-gateway typecheck
pnpm --filter @go-digital/whatsapp-gateway build
pnpm exec vitest run tests/api/personal-whatsapp-gateway.test.ts tests/api/personal-whatsapp-database.test.ts tests/api/personal-whatsapp-migration.test.ts
```

The migration test runs the complete CRM migration history in an isolated PGlite
database, then links, ingests and claims a reply with real access predicates.
Focused database tests cover policy/rate boundaries. Gateway tests mock Baileys;
they do not prove a real WhatsApp account can link or that upstream protocol
compatibility will remain stable. Baileys 7.0.0-rc14 is pinned for its current LID
and phone-number mapping support; its libsignal dependency resolves to the same
maintainer's published 6.0.0 package. Revalidate upstream changes before upgrades.

Before admitting pilot users, manually check both eligible roles: QR rotation and
expiry, scanning, connected status, a matched new inbound, a human reply, discarded
unmatched/ambiguous chats, another user's inability to read the messages, limits,
service restart and credential recovery, phone logout and disconnect. Check the
existing official channel independently. Monitor actual RSS under representative
traffic before increasing capacity or choosing a paid instance.

Disconnect revokes the database generation before closing the socket, deletes
saved auth keys and QR values, and retains CRM records under the existing retention
workflow. Also remove the linked device on the phone if WhatsApp was offline.
On a failed deployment, stop the gateway and disable linking first; do not drop
personal message tables or reset the database as a rollback shortcut.

References: [Baileys](https://github.com/WhiskeySockets/Baileys),
[Render Free limitations](https://render.com/docs/free),
[WhatsApp unofficial-app guidance](https://faq.whatsapp.com/378279804439436/).

## Local verification (2026-09-06)

- Full API/backend suite: 173 files, 1,021 tests passing at the final full run.
- Connector-specific tests: 36 passing, including a separate Node 24.20.0 run.
- Formatting, lint, web/gateway TypeScript, gateway build, Edge Function checks,
  Supabase function configuration and example-environment checks passed.
- Web production build passed on Node 24.20.0 as well as the workstation runtime.
- Not performed: live Supabase migration/deployment, Render provisioning, real
  phone QR pairing, manual browser acceptance, load testing or UptimeRobot setup.
  These remain release gates, not implied by mocked/isolated tests.
