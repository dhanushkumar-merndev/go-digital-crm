# Lead flow headed verification — 10 October 2026

## Changes

Lead rows, counters, phone history, personal preferences, assignment candidates,
vehicle model options and lead detail now use the existing `readRpc` transport.
Interactive reads have a ten-second deadline, propagate caller cancellation and
retain HTTP status for retry classification. Their query consumers, including
Inbox lead search and Telecaller dashboard counts, use `retryRpcRead`: one retry
for a transient failure, none for permission denials or cancelled requests.
Business mutations and RPC arguments are unchanged.

The same boundary also covers Inventory's branch/page/options/detail reads and
department case workspace, booking options and detail reads. Department detail
now accepts the query's cancellation signal. This extension follows a successful
RTO save whose unbounded workspace refresh subsequently timed out and left the
table stale.

The new transport regressions use the actual Supabase/PostgREST builder
with only HTTP replaced. It checks denied requests, cancellation before dispatch,
uncoded gateway failures followed by denial, and expired deadlines for each
reader. The initial 21 regression cases failed before the production changes;
all 28 lead cases pass after them. An independent review found no critical or important
issues; its two additional retry-policy findings were fixed.

The downstream extension adds 48 regressions; all failed against the previous
transport and pass after the fix. Timing capture and load replay share an
exact-name read-RPC allowlist. The previous prefix heuristic accepted
`get_or_create_pdi_inspection`, which can write; replay now excludes it even from
older captures. Five safety tests pass, including two that failed against that
heuristic. Independent review found no actionable issues with the allowlist.

## Verification

| Check                               | Result                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| API suite                           | 280 files, 2,032 tests passed                          |
| Targeted transport and safety tests | 92 passed, including 81 new cases                      |
| TypeScript                          | Passed                                                 |
| Production webpack build            | Passed                                                 |
| Changed-file ESLint and Prettier    | Passed                                                 |
| Full-repository ESLint              | Failed: 18 existing scratch-script errors, 12 warnings |
| Final headed acceptance run         | Pending                                                |

The existing 19-test headed suite exercises manual intake, deliberate customer
linking, contact and follow-up scheduling, Lost/unlinked handoff guards, atomic
follow-up handoff to another consultant for the same customer and phone,
sibling-lead RLS isolation, transfer cancellation, Sales appointments, test drives,
quotations, bookings, Finance/Insurance/RTO proofs, VIN allocation, PDI and signed
delivery, plus direct and existing-quotation booking alternatives.

Runs use visible Brave/Chromium on the local desktop and the remote demo tenant.
The original dev server remains running. The initial run passed 15 cases before
an inventory-loading timeout; the focused Delivery and alternative-booking rerun
passed all four cases. Another run stopped at the login access gate. An isolated
server passed the first 11 cases but its port was outside the storage CORS allow
list; a temporary origin-routing experiment also failed. Neither experiment
changed repository code or provider configuration. A subsequent run passed 13 cases before the RTO save succeeded but its status
refresh timed out, motivating the downstream transport fix. Final verification
uses the original application origin and existing acceptance suite; its timing
classifier now uses the shared read allowlist. After the downstream fixes, a full
run stopped at the first contact write with HTTP 500 / `57014` (11 seconds).
A focused downstream rerun passed RTO, then encountered the same SQL cancellation
on the booking-status write (12.5 seconds). These write failures are not retried
automatically. A fresh isolated headed browser run is in progress.

## Performance measurements and limits

The baseline read-only replay used five virtual users for 20 seconds with
approximately one second of think time: 80 requests, zero failures or refusals,
195 ms median and 1,106 ms p95, including network time. This is a small smoke
load, not a capacity estimate.

Live demo database profiling confirmed that first calls can be substantially
slower than repeat calls. In one transaction, the Finance scope helper took
2,358 ms first, then 15/8/2 ms; its page RPC took 3,305 ms first, then 55/39/35 ms.
A warm EXPLAIN measured 69 ms with shared-buffer hits and no disk reads. Browser
runs also recorded SQL statement cancellations (`57014`) around nine seconds.
These cold-call delays remain a performance limitation. Generic-plan and
join-planner experiments did not produce a reliable improvement; all experiments
were rolled back and no database migration was applied.

A transactionally rolled-back contact probe measured the live function's
authorization, lead-update triggers, stage history, activity projection,
same-phone takeover checks and audit phases. Together they took about 1,027 ms
first and 18 ms on repeat. This did not reproduce the slow REST failure, so it
does not identify a root cause. No blocking locks were observed in the sampled
database activity. The Management API denied timeout-log access with HTTP 403;
the user is enabling log-read access for further diagnosis.

The environment uses Node 26 while the project specifies Node 24. Existing
working-tree changes were preserved. Test records and uploaded proof files remain
in the demo tenant; business data was not hard-deleted.

## Reproduce

```bash
E2E_CHROMIUM_EXECUTABLE=/usr/bin/brave \
E2E_VISIBLE_BROWSER=true E2E_SLOW_MO=100 \
E2E_API_TIMINGS=/tmp/lead-flow-timings.jsonl \
pnpm exec playwright test tests/e2e/lead-flow.spec.mjs \
  --headed --workers=1 --reporter=line

node scripts/load-test-lead-flow.mjs /tmp/lead-flow-timings.jsonl \
  --users=5 --seconds=20 --think=1000 --repeats=1
```

Credentials are read from the existing environment and must not be included in
reports. Timing logs may contain customer searches or short-lived presigned URLs
from browser errors; keep the raw logs private.
