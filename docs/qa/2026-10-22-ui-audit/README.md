# Role-by-role UI audit — goal and progress

**Goal:** every web page of every role is screenshotted, judged against its PRD
section (AGENTS.md §54), fixed for wrong or missing KPIs, odd labels and broken
states, and brought to production latency. Roles run from the lowest to the
highest; each ends with an audit report in this folder and a re-run of the audit
harness showing every sidebar page rendering.

Harness: `E2E_AUDIT_DIR=playwright-report/ui-audit/<run> E2E_ROLES=<role> pnpm test:e2e:role-navigation`
against `next dev` (screenshots plus per-page call timings, git-ignored).

| #   | Role                                                                                     | Status | Report                               | Migrations                                         |
| --- | ---------------------------------------------------------------------------------------- | ------ | ------------------------------------ | -------------------------------------------------- |
| 1   | Telecaller                                                                               | Done   | —                                    | —                                                  |
| 2   | Sales Consultant                                                                         | Done   | —                                    | —                                                  |
| 3   | Team Manager                                                                             | Done   | [team-manager.md](team-manager.md)   | `202610240173` applied                             |
| 4   | Sales Manager                                                                            | Done   | [sales-manager.md](sales-manager.md) | `202610240191`, `202610240203` applied             |
| 5   | GM Sales                                                                                 | Done   | [gm-sales.md](gm-sales.md)           | `202610270157` applied                             |
| 6   | Operations desks (inventory, finance, insurance, RTO, exchange, delivery, customer care) | Done   | [operations.md](operations.md)       | `202610270179` applied                             |
| 7   | Digital Marketing                                                                        | Done   | [admin-roles.md](admin-roles.md)     | —                                                  |
| 8   | Client Admin                                                                             | Done   | [admin-roles.md](admin-roles.md)     | —                                                  |
| 9   | System Administrator                                                                     | Done   | [admin-roles.md](admin-roles.md)     | —                                                  |
| 10  | Business Owner                                                                           | Done   | [admin-roles.md](admin-roles.md)     | —                                                  |
| 11  | Super Admin                                                                              | Done   | [admin-roles.md](admin-roles.md)     | —                                                  |
| 12  | Mobile (Telecaller, Sales Consultant)                                                    | Done   | [mobile.md](mobile.md)               | `202610270193` applied, `202610270211` **pending** |

A migration marked pending is in `supabase/migrations` but not yet run against the
linked project; the page that needs it shows a fallback ("—" tiles or an
"unavailable" state) until it is. Apply one file without `db push` (other
sessions' drafts may sit in the folder):

```sh
npx supabase db query --linked -f supabase/migrations/<file>.sql
npx supabase migration repair --linked --status applied <version>
```
