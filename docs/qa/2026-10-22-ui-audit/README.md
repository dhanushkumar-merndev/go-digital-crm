# Role-by-role UI audit — goal and progress

**Goal:** every web page of every role is screenshotted, judged against its PRD
section (AGENTS.md §54), fixed for wrong or missing KPIs, odd labels and broken
states, and brought to production latency. Roles run from the lowest to the
highest; each ends with an audit report in this folder and a re-run of the audit
harness showing every sidebar page rendering.

Harness: `E2E_AUDIT_DIR=playwright-report/ui-audit/<run> E2E_ROLES=<role> pnpm test:e2e:role-navigation`
against `next dev` (screenshots plus per-page call timings, git-ignored).

| #   | Role                                                                                     | Status | Report                               | Migrations                             |
| --- | ---------------------------------------------------------------------------------------- | ------ | ------------------------------------ | -------------------------------------- |
| 1   | Telecaller                                                                               | Done   | —                                    | —                                      |
| 2   | Sales Consultant                                                                         | Done   | —                                    | —                                      |
| 3   | Team Manager                                                                             | Done   | [team-manager.md](team-manager.md)   | `202610240173` applied                 |
| 4   | Sales Manager                                                                            | Done   | [sales-manager.md](sales-manager.md) | `202610240191`, `202610240203` applied |
| 5   | GM Sales                                                                                 | Done   | [gm-sales.md](gm-sales.md)           | `202610270157` applied                 |
| 6   | Operations desks (inventory, finance, insurance, RTO, exchange, delivery, customer care) | Done   | [operations.md](operations.md)       | `202610270179` applied                 |
| 7   | Digital Marketing                                                                        | Done   | [admin-roles.md](admin-roles.md)     | —                                      |
| 8   | Client Admin                                                                             | Done   | [admin-roles.md](admin-roles.md)     | —                                      |
| 9   | System Administrator                                                                     | Done   | [admin-roles.md](admin-roles.md)     | —                                      |
| 10  | Business Owner                                                                           | Done   | [admin-roles.md](admin-roles.md)     | —                                      |
| 11  | Super Admin                                                                              | Done   | [admin-roles.md](admin-roles.md)     | —                                      |
| 12  | Mobile (Telecaller, Sales Consultant)                                                    | Done   | [mobile.md](mobile.md)               | `202610270193`, `202610270211` applied |

## Regression run 2026-10-28

- Web: all 24 roles, 223 pages and tabs, pass the harness (warm median 1.27 s to settled).
- Mobile (emulator release build): Telecaller Today / Leads / Follow-ups / Tasks / lead detail and
  Sales Consultant Today / Leads / Schedule (follow-ups, visits, test drives) / Tasks render with
  counts matching web; cold start to first frame about 0.2 s.
- Latency, measured as each demo user: Team Manager and Sales Manager dashboards read the summary
  directly (~300 ms) instead of the per-user Edge cache (400–900 ms hit, 1.6–7 s cold); the Sales
  Consultant's own Performance likewise (~150 ms). GM, Business Owner and Client Admin keep Redis,
  since their org-wide summary is 0.8–1.8 s in PostgreSQL.
- Team and Sales Manager Performance read `get_team_manager_performance` directly (100–550 ms vs
  300–1,200 ms Edge hit). The Sales Consultant dashboard reads its RPC directly (~0.25 s)
  and fetches the Edge-signed stock thumbnails alongside (kept 4 min; links last 5): settled
  9.4 s → 3.6 s warm on the production build.
- Production build (`next build` + `next start`, real login form, non-MFA roles): 93 pages, median
  ~0.82 s and p90 ~1.34 s from sidebar click to rendered page.
- Final dev run after all changes: 24/24 roles pass, median 1.19 s.
- Production build, all 24 roles incl. MFA ones (signed in via the dev server with
  `E2E_LOGIN_BASE_URL=http://localhost:3100 E2E_BASE_URL=<next start>`): 24/24 pass, 223 pages,
  median 1.08 s per full page load.
- `get_inventory_dashboard` resolves branch scope once: 1.2–1.6 s → ~45 ms, identical output.
  Migration `202610280101` **pending**.

A migration marked pending is in `supabase/migrations` but not yet run against the
linked project; the page that needs it shows a fallback ("—" tiles or an
"unavailable" state) until it is. Apply one file without `db push` (other
sessions' drafts may sit in the folder):

```sh
npx supabase db query --linked -f supabase/migrations/<file>.sql
npx supabase migration repair --linked --status applied <version>
```
