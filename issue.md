# Headed lead-flow and integration QA

Updated: 2026-10-03

## Current verification status

- API suite: **1,497 tests passed** (224 files).
- TypeScript: **passed** (`pnpm typecheck`).
- Browser lead flow: **18/18 stages passed in one uninterrupted run**, including lead creation, assignment/handoff, test drive, quotation, booking, finance, insurance, RTO, inventory allocation, delivery proof upload, completed delivery, and alternate booking paths.
- Live lead receipt: deployed `lead-ingest` returned HTTP 201; the test lead was persisted with source traceability, assigned in `New`, and visible within the receiving Telecaller's scope.

## Findings

### QA-001 — Interactive RPC reads could stall or fail without usable recovery

Status: **Fixed and verified**

- `get_active_call_status` and Sales handoff candidate reads intermittently returned transient 5xx responses.
- Added a 10-second bounded read, one retry for transient failures, correct cancellation handling, and visible retry UI.
- Handoff submission remains blocked while candidates are loading or failed; an error is no longer shown as a fake empty team.
- Injected headed 503/recovery checks passed.

### QA-002 — Quotation draft could navigate before persistence completed

Status: **Fixed and verified**

- The test treated the button label changing from `Save Draft` to `Saving…` as completion and could abort `save_quotation` by navigating away.
- The flow now waits for the successful save RPC, validates the returned quotation ID/status, and waits for the editor to close.
- Existing-draft booking regression passed.

### QA-003 — Vehicle catalogue loading could replace a field while typing

Status: **Fixed and verified**

- Model/variant/colour controls could change from manual input to a dropdown after the first character when catalogue data arrived.
- Controls now expose a loading state and choose input/dropdown from actual catalogue options.
- Delayed empty and populated catalogue headed checks passed.

### QA-004 — Demo test-drive inventory becomes exhausted across full runs

Status: **Fixed and verified**

- The vehicle picker correctly showed “No test-drive vehicle is available” because every AVAILABLE unit was held by a scheduled appointment, while the fixed seed vehicles had already progressed to delivery states.
- The browser flow now provisions two fresh, unique, valid 17-character VINs in the lead's demo branch: one for the test drive and one for booking allocation.
- Provisioning uses the Inventory Manager's normal `create_stock_unit` RPC; no delivered vehicle or history is reset.
- The complete 18-stage browser flow passed after the change.

### QA-005 — Operational case Sheet plays its entrance animation twice

Status: **Fixed and verified by typecheck/headed delivery flow**

- Root cause: the Sheet key changed from `case-id` to `case-id:version` when detail data loaded, so React unmounted the first Sheet and mounted a second one.
- The key is now stable for the selected case. Changing to a different case still resets local state, but detail loading/version refreshes no longer replay the entrance animation.

### QA-006 — Delivery proof upload test timed out although upload was progressing

Status: **Fixed and verified**

- The presign → object-store PUT → finalize chain is sequential. One presign took 21 seconds, but all observers expired after 30 seconds from initial file selection.
- The headed test now allows 90 seconds for the provider upload chain.
- Resumed delivery test passed in 26.5 seconds; a later full-run delivery test passed in 1.7 minutes with finalize HTTP 201.

### QA-007 — Role-switch navigation can be cancelled by transient Supabase auth/CORS failure

Status: **Runner hardened and verified**

- Chromium reported `net::ERR_ABORTED` while opening Telecaller My Leads after delivery.
- Timing logs show a simultaneous Supabase CORS/network failure during auth/logout, while the same booking path passed in focused execution.
- Added one narrow retry for `ERR_ABORTED`; other navigation failures still fail immediately.
- The final uninterrupted 18-stage rerun completed successfully on 2026-10-03.

## Next provider integration pass

Run after the final lead-flow rerun:

1. Facebook Lead Ads: one-click connection, page/form selection, safe provider test lead, webhook ingestion, source/campaign/external ID/raw-payload traceability, duplicate-event idempotency, and branch mapping.
2. IndiaMART: one-click connection, credential validation, test enquiry ingestion, source mapping, idempotency, and visible connection health.
3. CarDekho: same connection and end-to-end lead-ingestion checks.
4. CarWale: same connection and end-to-end lead-ingestion checks.
5. Verify disconnect/reconnect and error states without publishing ads, spending money, or changing campaign settings.

Browser prerequisite: Chrome must be open with the Codex browser extension connected. The browser inventory was empty when checked on 2026-09-29.

Automated baseline completed: **52/52 provider tests passed** across Meta parsing, Indian auto-portal adapters, integration workspace contracts, provider event dispatch, provider security, provider asset mapping, and field mapping.

Meta MCP note: Meta's official `Meta Social Technologies` remote MCP (`https://mcp.facebook.com/devtools`) supports app inspection, webhook subscription inspection/management, API health, and sending real test webhook payloads. It can validate the Facebook callback safely after OAuth. It does not operate Lead Ads campaigns directly.

Connection UX constraint: Meta supports an OAuth-style one-click handoff. IndiaMART, CarWale, and CarDekho currently require their issued mobile/dealer ID plus API/CRM key, followed by registering the generated webhook URL in the provider portal. They cannot honestly be described as zero-credential one-click connections unless those providers offer an OAuth/onboarding API for this dealership account.
