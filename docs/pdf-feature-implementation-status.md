# PDF feature implementation status

Updated: 7 September 2026. This is an implementation tracker, **not a completed UAT certificate**.

Sources: `Car_Dealership_CRM_Master_QA_UAT_Verification_Checklist.pdf` in the repository and the two original checklists supplied from Downloads. Their requirements are evidence for the requested work; their existing “Pass” labels are not test results from this session. The open PDF contains inconsistent summaries: for example, its second page describes accessories/PDI implementations while its closing summary calls them missing.

## Implemented in this change

| PDF requirement | Implemented behavior | Evidence |
| --- | --- | --- |
| Model and variant configuration | Create/edit/deactivate models and variants; searchable parent selection reaches records beyond the first page; missing records produce explicit errors; parent IDs are checked in the current tenant. | `202609070101_vehicle_master_completion.sql`, `master-data-workspace.tsx` |
| Colour configuration | Tenant colour catalog, creation, editing and deactivation; RLS-protected reads; stock intake and editing use the catalog and retain existing colour text. | Same migration; `vehicle-colour-input.tsx`, `inventory-dialogs.tsx` |
| Specification editing | Edit fuel, transmission, engine capacity, power, mileage, seats, EV range and boot space; retain other existing specification properties. | `master-data-workspace.tsx` |
| Historical master behavior | Catalog edits do not rewrite saved stock colours or sales documents. Changes retain old/new audit metadata. | Vehicle master migration and executable PostgreSQL tests |
| Customer date reminders | Birthday/anniversary defaults and opt-in annual reminders for other customer DATE fields; administrator can enable/disable a field with version-conflict protection. | `202609070103_customer_date_and_lead_sla_alerts.sql`, Custom Fields workspace |
| Five-minute lead SLA | Notify the assigned user and eligible Team Manager after five minutes with no recorded call/contact. Do not change lifecycle status. | Same migration; `crm-alerts.ts` |
| Notification centre | Deduplicate alerts across retries/read-state changes; link lead alerts to Lead Detail and date alerts to Customer 360 from the bell, sheet and page. | Notification components and `record-links.ts` |
| Feedback / complaint routing | A low rating captured through the existing feedback table transition creates one high-priority complaint and a visible Customer Care case with an eight-hour SLA; retries do not create duplicate complaints. | `202609070102_feedback_access_and_completion.sql` |
| Feedback access and truthful status | Block anonymous/foreign-tenant/out-of-scope feedback submissions; reject changes to completed responses; record newly created feedback requests as PENDING with no fabricated sent timestamp. | Same migration; executable PostgreSQL access tests |

Date reminders are internal notifications to eligible current lead owners for linked customers, not outbound greetings. They use Asia/Kolkata calendar dates. A 29 February anniversary fires on 29 February in leap years; it is not shifted to another day. Deactivated date definitions, inactive accounts and suspended tenants are excluded. The dispatcher processes at most 200 lead alerts and 200 date alerts per existing marketing scheduler pass, so a large backlog drains over subsequent passes.

The colour catalog is initially empty; an administrator adds the dealership's supported colours. Existing stock colour text remains visible even if no active catalog entry matches it. The new catalog is dealership-wide, consistent with the existing tenant-owned model and variant masters; this is not a new platform-wide shared catalog.

## Confirmed remaining gaps

These requirements must not be marked complete just because a page or SQL table exists.

| Requirement | Current evidence / remaining work |
| --- | --- |
| CallerDesk IVR | TeleCMI integration exists. A CallerDesk-specific adapter and live workflow verification remain. |
| Manual and automated SMS | `send-message` handles WhatsApp; drip and bulk dispatch explicitly reject SMS. SMS provider selection, connection/configuration, sending, delivery receipts, retry handling and live testing remain. |
| LinkedIn, YouTube and X publishing | Supported publishing adapters and their OAuth/media workflows remain. |
| Google Business Profile publishing | Draft/configuration support exists; the current publisher implements Facebook and Instagram only. |
| Social engagement metrics | Live metrics collection remains. |
| Daily backup / backup management | Runbook exists. The application backup history/trigger/restore workflows and a verified recovery exercise remain. Database recovery and Tigris file recovery both need coverage. |
| Customer and stock bulk imports | Existing import implementation handles leads. Customer/stock mapping, validation, permissions, duplicate handling and imports remain. |
| Inventory and exchange photos / RC uploads | These are explicitly deferred in `ISSUE.md`; private upload/gallery workflows remain. |
| Detailed source/model/availability assignment rules | Existing team eligibility and round robin/manual assignment require further verification against the PDF's more detailed routing requirement. |
| Automated review delivery after feedback | Positive feedback records the configured review URL; this change does not dispatch a review message. The existing review-request queue still requires an end-to-end send/receipt audit. |
| Accessories stock and PDI readiness | Workspaces and database functions exist. A full branch/permission, stock-reservation and delivery-gate audit remains; their presence is not a complete workflow verification. |
| AI voice calls | CRM gateway orchestration exists. A configured external voice gateway and actual call/callback test remain. |
| SIM recordings / GPS tracking | Manual recording upload and mobile route buffering exist. Release-device permission, upload, background tracking and interrupted-network tests remain. The checklist's manual upload requirement does not by itself authorize replacing Expo with a native automatic call recorder. |

## Other PDF coverage requiring runtime UAT

The repository contains implementations and tests in the areas below. They were included in the regression suite, but the full user journeys were **not** run against a staging dealership/provider environment in this change.

| PDF items | Implementation areas |
| --- | --- |
| Lead capture/list, add/edit, source portals, customer matching | `features/leads`, `features/customers`, `lead-ingest`, provider ingestion |
| Assignment and reassignment history | Lead assignment workspace and transactional assignment RPCs |
| Follow-ups and callbacks | `features/work`, lead detail and mobile work screens |
| Calling, recordings, transcripts, AI field review, previous-call summary | `features/calls`, mobile call detail, `ai-call-processing`, AI Edge Functions |
| Personal WhatsApp QR/global configuration | Personal WhatsApp pilot and `services/whatsapp-gateway` |
| Official WhatsApp, templates, broadcasts, drip campaigns | Inbox, template approval, customer drip and bulk campaign dispatch |
| Email, brochures/quotations and email history | Brevo email boundary and provider outbox |
| Facebook/Instagram post creation, scheduling and history | Social calendar and `social-post-publish.ts`; live publishing still needs provider tests |
| AI poster generation and reusable templates | AI image generation and marketing asset library |
| Customer activity timeline and automatic activity updates | Customer 360, role timelines and domain audit/activity writes |
| Competitor comparison | Competitor catalog and comparison workspace |
| Quotation, booking, prices, discounts and downstream operations | Sales document workspaces and booking/approval RPCs |
| Inventory, allocation, movements, stock age | Inventory workspace and stock RPCs |
| Exchange valuation, finance, insurance and RTO | Operational case workspaces and departmental RPCs |
| Delivery readiness and handover | Delivery case workflow and checklist |
| Customer feedback, complaints, escalation and reviews | Customer Care, delivery feedback, marketing reviews; limitations above apply |
| Dashboards, role reports and export | ECharts dashboards, report/export worker and Tigris |
| Tenancy, branch scopes, RBAC and permission ceilings | Auth/RLS and role administration; new/legacy RPCs still need staging denial tests |
| Audit and activity history | Audit workspace and domain audit records |
| Authentication, MFA, sessions and security | Supabase Auth access gates, role session policy and security workspace |
| Branch/showroom, users, teams and hierarchy | Branch/team/user administration |
| Approval workflows and targets | Manager approvals and target configuration |
| Custom fields, CRM settings, templates and alert rules | Administration workspaces; frozen lifecycle rules continue to follow `AGENTS.md` |
| Integration configuration and import mapping | Integration workspace and lead import; missing providers/import resources listed above |
| Global model/variant/colour/specification impact | Tenant catalog updates added above; dependency screens and historical documents need manual UAT |
| Role-wise verification matrix | Telecaller, Sales Consultant, Team Manager, Showroom Manager, GM, Owner, Inventory, Exchange, Finance, Insurance, RTO, Accessories, Delivery, Customer Care, Client Admin and Super Admin must each run their permitted workflows and denial cases. |

## Validation and rollout

New executable PostgreSQL tests load the migrations against isolated PGlite fixtures. They exercise actual function execution, role grants/RLS where applicable, tenant/scope denial, configuration concurrency, deduplication, pagination, historical values and notification timing. This is stronger than checking that a function name appears in a SQL file, but it is still not a full Supabase migration-chain or live-provider test.

Required release sequence:

1. Apply `202609070101`, `202609070102` and `202609070103` to an isolated staging database using the existing migration workflow. They have not been applied remotely in this session.
2. Deploy the web build and the updated `marketing-dispatch` worker together with its `crm-alerts` module. No extra scheduler slot is required.
3. Create/edit/deactivate catalog records as Client Admin, verify stock colour selection, and inspect old/new audit values. Repeat denied operations from another tenant and a role without management permission.
4. Configure a customer DATE reminder, add test data, and observe one notification for its eligible owner. Repeat the scheduler and mark the notification read; neither should create another alert for the same day.
5. Leave a test lead uncalled for five minutes and observe owner/manager notifications. Record a call before expiry on a second lead and confirm no SLA notification. Verify the lifecycle remains unchanged.
6. Capture low delivery feedback from the normal Delivery Feedback screen. Confirm one visible complaint/Customer Care case, audit entry and customer activity. Check that repeated or unauthorized submissions are rejected or safely replayed.
7. Complete desktop and release-device UAT, live-provider checks and backup/recovery checks before signing any PDF row as fully passed.

Docker and `psql` are unavailable in this environment, so a fresh local Supabase migration-chain run is not included. No live calls, customer messages, social posts, production migrations or restore operations were performed.
