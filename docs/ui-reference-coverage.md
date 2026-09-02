# UI reference coverage

This is the implementation map for the approved screenshots in
`/home/dhanush/Downloads/docs`. It is intentionally grouped by workflow because several image
filenames do not match their visual content (notably `20`/`21` and `86`).

Every listed route is backed by role-scoped workspace data or a controlled mutation. Reference
screens are not represented by static/mock-only pages.

| Reference group                             | Role route / mobile entry                                                                                                            | Working workspace                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `1`–`8` Telecaller                          | `/telecaller/dashboard`, leads, follow-ups, tasks, calls, messages, performance                                                      | `TelecallerDashboard`, `LeadWorkspace`, `WorkWorkspace`, `TaskWorkspace`, `CallWorkspace`, `InboxWorkspace`         |
| `9`–`24` Sales Consultant                   | `/sales-consultant/dashboard`, leads, customer 360, calls, messages, test-drives, quotations, bookings, stock, exchange, performance | Sales dashboard, `Customer360Workspace`, calls/inbox, test-drive, sales-document, inventory and exchange workspaces |
| `25`–`32` Team Manager                      | dashboard, team leads, assignment, calls, follow-ups, escalations, performance, reports                                              | team performance, lead assignment, call/work/escalation and report workspaces                                       |
| `33`–`36` Showroom Manager                  | dashboard, showroom leads, sales teams, approvals, targets, assignment, performance                                                  | showroom sales-team/target, lead assignment, manager approvals and dashboard workspaces                             |
| `37`–`41` GM Sales                          | dashboard, source performance, showroom comparison, consultant ranking, model performance, targets                                   | GM analytics and GM target workspaces                                                                               |
| `42`–`46` Inventory                         | dashboard, vehicle inventory, allocation, ageing, transfer                                                                           | `InventoryWorkspace`                                                                                                |
| `47`–`49`, `51`–`52`, `57`, `59` Operations | insurance, RTO and delivery dashboard/list/detail paths                                                                              | `OperationalCaseWorkspace` and delivery feedback workspace                                                          |
| `61`, `62`, `64` Business Owner             | executive dashboard, sales overview, AI/credit summary                                                                               | tenant dashboard and owner AI summary                                                                               |
| `65`–`79` Administration                    | users, roles, branches, master data, integrations, automations, templates, alerts, audit, exports, security                          | administration and integration workspaces                                                                           |
| `80`–`85` Platform                          | platform dashboard, dealership/detail, plans, credits, providers, health, access                                                     | platform workspaces                                                                                                 |
| `87`–`90` Shared/AI calls                   | notification/task center, activity timeline, AI field review                                                                         | shared header centers, activity timeline and AI call-review workspaces                                              |
| `91`–`99` Marketing AI                      | AI voice calls, drip/review automation, social calendar, AI image creation                                                           | AI voice, marketing automation, social calendar and AI image workspaces                                             |
| `100`–`105` Mobile                          | Sales Consultant home, leads, customer, call, test-drive/GPS and stock check                                                         | Expo Router sales screens and mobile data adapters                                                                  |

## Reference-specific details

- `20 - Competitor Comparison Page UI.png` and `21 - Stock Check Page UI.png` are visually
  swapped. The competitor page is `/sales-consultant/competitor-compare`; the stock page is
  `/sales-consultant/stock-check`.
- Competitor comparisons show only tenant-configured, verified competitor data. The screen does
  not fabricate AI talking points or vehicle specifications.
- AI images and call recordings/transcripts use private-object access and short-lived URLs only.
- The Sales Consultant mobile Home and My Leads screens have been aligned with their references
  using only dashboard/lead data actually returned to the mobile client.
- The shared Expo screen shell now uses the same compact top app-bar density as the approved
  mobile references, so the live lead, call, customer, work and stock screens stay visually
  consistent without duplicating their chrome.
- The live Test Drive workspace uses the same compact mobile heading density while retaining its
  real GPS, odometer, recovery and feedback workflow.

## Intentional non-routes

- GM Sales and Showroom Manager `Users` are hidden future navigation capabilities. Existing
  user-management RPCs correctly authorize Client Admin/System Administrator only; exposing the
  generic user workspace to managers would violate delegation scope.
- Super Admin `Platform Settings` needs an approved, server-side settings schema and authority
  policy before it can become a functional screen. It must not be replaced with a mock settings
  form.

## Verification baseline

After the latest alignment work:

- API contracts: `pnpm test:api`
- Web types: `pnpm typecheck`
- Mobile types: `pnpm --dir mobile typecheck`
- Production web bundle: `pnpm build:webpack`
- Whitespace integrity: `git diff --check`

The repository requests Node `24.x`; local checks currently emit only a non-failing Node `26`
engine warning.

The shared web shell was additionally rendered with local Chromium at desktop reference width
(`1536 × 1024`) in safe local-preview mode. The sidebar, top application header, role navigation
and main-content spacing render successfully. Live workspace records are intentionally not
available in that mode because the dashboard RPC still requires a signed, active scoped account;
that final data-backed visual comparison must use an authorized workspace session.
