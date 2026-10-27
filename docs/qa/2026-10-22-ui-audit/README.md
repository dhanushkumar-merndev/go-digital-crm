# Role-by-role UI audit — goal and progress

**Goal:** every web page of every role is screenshotted, judged against its PRD
section (AGENTS.md §54), fixed for wrong or missing KPIs, odd labels and broken
states, and brought to production latency. Roles run from the lowest to the
highest; each ends with an audit report in this folder and a re-run of the audit
harness showing every sidebar page rendering.

Harness: `E2E_AUDIT_DIR=playwright-report/ui-audit/<run> E2E_ROLES=<role> pnpm test:e2e:role-navigation`
against `next dev` (screenshots plus per-page call timings, git-ignored).

| #   | Role                                                                                     | Status                       | Report                               | Migrations                                         |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------ | -------------------------------------------------- |
| 1   | Telecaller                                                                               | Done                         | —                                    | —                                                  |
| 2   | Sales Consultant                                                                         | Done                         | —                                    | —                                                  |
| 3   | Team Manager                                                                             | Done                         | [team-manager.md](team-manager.md)   | `202610240173` applied                             |
| 4   | Sales Manager                                                                            | Done, one migration to apply | [sales-manager.md](sales-manager.md) | `202610240191` applied, `202610240203` **pending** |
| 5   | GM Sales                                                                                 | Next                         | —                                    | —                                                  |
| 6   | Operations desks (inventory, finance, insurance, RTO, exchange, delivery, customer care) | To do                        | —                                    | —                                                  |
| 7   | Digital Marketing                                                                        | To do                        | —                                    | —                                                  |
| 8   | Client Admin                                                                             | To do                        | —                                    | —                                                  |
| 9   | System Administrator                                                                     | To do                        | —                                    | —                                                  |
| 10  | Business Owner                                                                           | To do                        | —                                    | —                                                  |
| 11  | Super Admin                                                                              | To do                        | —                                    | —                                                  |

A migration marked pending is in `supabase/migrations` but not yet run against the
linked project; the page that needs it shows a fallback ("—" tiles or an
"unavailable" state) until it is. Apply one file without `db push` (other
sessions' drafts may sit in the folder):

```sh
npx supabase db query --linked -f supabase/migrations/<file>.sql
npx supabase migration repair --linked --status applied <version>
```
