# CONTINUE — Sales Consultant API / scale work

**Last session:** 2026-08-20
**Branch:** `main`
**Goal:** Sales Consultant workspace production-ready; ~1,000 users day one, must hold
50,000+; ~100,000 leads per organization.

---

## Read this first

Nothing in this session has been applied to the database. Two migration files were
written but **not run**. One of them (`202608200015`) has a **known unfinished
section** — details in "Known gaps" below. Do not deploy it as-is.

The Supabase MCP account connected here does **not** have the CRM project
(`yzplfphnpoksvcetwhad`) — it only lists CTMEDIA / KhanaBanao / one other. No
`supabase` CLI, no `psql`, no `docker` on this machine either. So **nothing below
was verified against real data or a real planner.** Every performance claim is
static analysis and needs `EXPLAIN (ANALYZE, BUFFERS)` before it is trusted.

---

## Done and verified

### 1. Realtime 42501 — `202608200014_fix_realtime_policy_helper_execution.sql`

**Status:** written, not applied. Low risk, high confidence.

`202608150013` ended with a blanket revoke:

```sql
revoke all on function app_private.realtime_topic_organization() from public, anon, authenticated;
revoke all on function app_private.realtime_topic_resource()     from public, anon, authenticated;
```

Those two are **RLS policy helpers** on `realtime.messages`. A policy expression
runs as the *calling* role — `SECURITY DEFINER` changes the body's privileges, not
the caller's right to invoke the function. So every authenticated subscribe raised
`42501 permission denied for function realtime_topic_organization`, and the client
retried on a ~4s loop (visible in the logs as one error every 4 seconds).

The other two functions in that same revoke list
(`broadcast_tenant_invalidation`, `broadcast_platform_invalidation`) are **trigger**
functions — they run in owner context, so revoking them is correct. The two policy
helpers were swept in by mistake.

Fix = `grant execute … to authenticated` for the two policy helpers only.
Identical defect and identical remedy to `202608150034` (directory policy helper).

**Verify after applying:** subscribe as a normal user, confirm the 4s `42501` loop
stops in the Postgres logs and realtime invalidation actually delivers.

### 2. Notifications showed already-read items — `src/features/notifications/notification-api.ts`

**Status:** done, typechecks, prettier clean.

`fetchHeaderNotifications` selected the latest 8 rows regardless of `read_at`, so
read notifications stayed in the bell. Screenshot showed "You are up to date" with
three items still listed.

Added `.is('read_at', null)`. Filtering server-side (not client-side) matters: with
client-side filtering a backlog of read rows would consume the 8-row window and
push genuinely unread items out of view.

Empty state ("All caught up") and `unreadCount` already read correctly against an
unread-only list — no header changes needed. The
`notification.read_at ? 'bg-slate-300' : 'bg-blue-500'` dot in
`src/components/shared/app-header.tsx` is now always blue; harmless, left alone.

---

## Written but NOT finished — `202608200015_scale_tenant_dashboard_leads.sql`

**Status: DRAFT. Do not apply. Has a known bug (see gap A).**

### The diagnosis (this part is solid)

`get_tenant_dashboard_summary` → 500 / `57014 canceling statement due to statement
timeout`. Chain: `get_tenant_dashboard_summary` → `get_tenant_performance_dashboard`
(defined in `202608150035_optimize_tenant_dashboard.sql`).

Two compounding defects:

**(1) Per-row SECURITY DEFINER calls — the real killer.** Every scoped scan filters
with `app_private.can_access_record(...)` in the `WHERE`. That helper is
`SECURITY DEFINER`, which makes it **non-inlinable** by the planner, so it becomes a
real function call *per candidate row*. Each call runs `can_access_organization()`
plus `EXISTS` over `user_role_assignments ⋈ roles`, `branches`, and `team_members`
(see `202608150021_branch_team_administration.sql:244`). The leads table is scanned
this way **twice** — once in the KPI block, once in the trend block — so 100k leads
≈ 200k helper invocations for a single dashboard load. That is the timeout.

The same pattern appears **23 times** in
`202608200001_sales_consultant_dashboard.sql` (`grep -c can_access_record`), so the
Sales Consultant dashboard has the identical ceiling.

**(2) Non-sargable date predicates.** `timezone(tz, created_at)::date = local_today`
wraps the indexed column in a function → no index usable → full scan. Same for the
`date_trunc('month', timezone(...))` month filters.

**(3) Wasted work.** `get_tenant_dashboard_summary` called the *full* dashboard and
then stripped `lead_preview` and `attention` with the jsonb `-` operator — paying to
build both sections before throwing them away.

### The approach taken

Deliberately **did not** rewrite `can_access_record`'s semantics into an inlined
predicate. That would be the theoretically faster fix, but it is the single most
security-critical function in the codebase (tenant isolation), it has intricate
multi-assignment union semantics — `ORGANIZATION` / `ALL_BRANCHES` / `ONE_BRANCH` /
`SELECTED_BRANCHES` / `OWN_RECORDS` (with its own branch+team fallback) / `OWN_TEAM`,
plus a support-session bypass — and there is no way to test equivalence here. Getting
it subtly wrong is a cross-tenant data leak.

Instead: **enumerate the DISTINCT `(branch_id, team_id, assigned_user_id)` tuples
once, call `can_access_record` once per tuple, then join rows against the allowed
tuple set.** Same function, same arguments, so the permission boundary is
bit-for-bit identical — only the invocation count drops, from O(rows) to
O(distinct scopes), which is bounded by branches × teams × users (hundreds), not by
lead volume.

Also: half-open timestamptz ranges (`>= day_start and < day_end`) computed once into
locals; narrow column lists; the 5-row preview split out as its own ordered limit;
implementation moved to `app_private.tenant_performance_dashboard(days, tz,
include_live_items)` so the summary variant can skip building what it used to strip.

New indexes in the migration: `leads_org_scope_idx`, `leads_org_updated_active_idx`,
`calls_org_scope_idx`, `bookings_org_scope_idx`.

### Known gaps — fix these before applying

**A. BUG — the bookings-trend block is wrong.** It rebuilds `activity_result` by
indexing back into the jsonb the leads block just produced:

```sql
'value', coalesce((activity_result -> (day_row.row_index - 1) ->> 'value')::bigint, 0)
```

This is fragile and wrong when `can_view_leads` is false (`activity_result` is still
`[]`, so every primary value silently becomes 0). **Rework:** build the lead daily
series and the booking daily series in a *single* statement with both CTEs, and
`FULL JOIN` them onto the `generate_series` day spine. Do not carry state through
jsonb between statements.

**B. REGRESSION — the calls-as-primary trend path was dropped.** Original
`primary_daily` was `leads UNION ALL calls`, where calls only contribute when
`not can_view_leads and can_view_calls`. The rewrite kept only the leads branch, so a
caller with `call.view` but no `lead.view` now gets an empty primary series. Restore
it as part of fixing (A) — note `activity_primary` in the returned payload already
says `'Calls'` in that case, so the payload and the data currently disagree.

**C. Unconverted scans.** `followups`, `appointments`, `calls`,
`test_drive_appointments` still use per-row `can_access_record` (plus
`can_access_lead` / `can_access_customer`, which are *also* SECURITY DEFINER and
per-row). They are bounded by `day_start`/`day_end` now so they are much smaller
working sets, but calls in particular will grow with lead volume. Apply the same
distinct-scope treatment.

**D. Index creation locks.** The migration uses plain `create index if not exists`
inside `begin/commit`, matching repo style. At 100k rows that is a short
`ACCESS EXCLUSIVE`-ish stall but it is not free on a live table. Consider
`create index concurrently` outside the transaction for the production run.

**E. Not verified at all.** No EXPLAIN, no timing, no correctness check that the
distinct-scope join returns exactly the same row set as the per-row filter. **That
equivalence check is mandatory before this ships** — it is the whole safety argument.
Suggested: run both predicates over the same org and diff the id sets.

---

## Not started

- **Sales Consultant dashboard skeletons.** `src/features/dashboards/sales-consultant-dashboard.tsx`
  (942 lines) is the one workspace missing from the skeleton list — `Skeleton` /
  `animate-pulse` appear in ~20 other feature files but not there. Infra already
  exists: `src/components/ui/skeleton.tsx`, `src/components/shared/page-skeleton.tsx`.
- **The other Sales Consultant pages.** User said they would supply the URLs — get
  that list. Routes are all wired in `src/app/[role]/[[...slug]]/page.tsx`: my-leads,
  follow-ups, tasks, calls, appointments, test-drives, quotations, stock-check,
  exchange, bookings, performance.
- **"Live workspace unavailable" (GDM-DATA-BOUNDARY) on Performance.** Screenshot
  shows the boundary card on the Performance page, but
  `src/app/[role]/[[...slug]]/page.tsx:112` routes `sales-consultant` + `performance`
  to `<SalesConsultantPerformance />` *unconditionally* (no `isLocalPreviewMode()`
  guard), so it should be unreachable. **Unresolved** — either the screenshot predates
  that route or the deployed build is stale. Confirm which before chasing it.
- **Redis / TanStack tuning.** `202608150041_workspace_redis_cache.sql` and
  `src/lib/query/cached-dashboard-api.ts` exist; the Sales Consultant dashboard goes
  through the `sales-consultant-dashboard` edge function. Not yet reviewed for cache
  keys, TTLs, `staleTime`, or request coalescing under 50k users.
- **Real flows vs. placeholder data.** User's complaint about "random data popup which
  is not useful" not yet investigated.

---

## Suggested order next session

1. Apply `202608200014` (realtime grant) — smallest, highest certainty, unblocks all
   realtime and stops the retry storm.
2. Ship the notification fix.
3. Fix gaps (A) and (B) in `202608200015`, then run the equivalence check (E) and
   EXPLAIN before applying.
4. Get the page URL list from the user; do Sales Consultant skeletons.
5. Then the SC dashboard's own 23 `can_access_record` call sites.

## Useful commands

```bash
npx tsc --noEmit
npx prettier --check <files>
grep -c "can_access_record" supabase/migrations/202608200001_sales_consultant_dashboard.sql   # 23
```
