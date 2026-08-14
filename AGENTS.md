# AGENTS.md — Go Digital Marketing CRM

> **Authority:** This file is the implementation contract for the Go Digital Marketing multi-tenant automobile dealership CRM. Agents and developers must follow it unless the product owner explicitly changes a rule.
>
> **Visual references:** The approved role screenshots supplied during product discovery are the visual reference for layout, density, hierarchy, cards, tables and navigation. Recreate that design language using only the approved UI stack below. If a screenshot conflicts with a frozen product rule in this file, **this file wins**.

---

## 0. Non-negotiable decisions

1. Product name: **Go Digital Marketing CRM**.
2. Multi-tenant hierarchy: `PLATFORM -> DEALERSHIP ORGANIZATION/TENANT -> BRANCHES -> TEAMS -> USERS`.
3. Security model: `USER -> ROLE -> PERMISSIONS -> DATA SCOPE`.
4. Role is never the same thing as branch/data scope.
5. Data scopes must support `ONE_BRANCH`, `SELECTED_BRANCHES`, and `ALL_BRANCHES`; lower-level roles can additionally be limited to team/own-record scope.
6. The final sales hierarchy is:
   `GM Sales Executive -> Showroom Manager -> Team Manager -> Sales Consultant + Telecaller/BDC`.
7. **There is no Team Leader role.** Do not reintroduce it.
8. Customer is the long-term source of truth. A Lead is one enquiry/opportunity.
9. `customer_id` is an immutable UUID. Phone/email are matching/search identifiers only, never the customer primary key.
10. Same customer may have multiple leads, multiple bookings, multiple purchases, and multiple vehicles.
11. Do not silently merge customers from a phone match. Show a possible match and let an authorized user link or create a new customer.
12. `New` is a lifecycle state. `Pending` is a **derived work-state**, not a lifecycle state.
13. Default derived lead work-state:
    - uncontacted `<24h`: `NEW_TODAY`
    - uncontacted `>=24h`: `PENDING`
    - past configured SLA: `SLA_RISK`
14. Assignment mode is configurable per team: **Round Robin (default)** or **Manual Assignment**.
15. All important assignment/reassignment changes must be auditable.
16. Web UI base components: **shadcn/ui only**.
17. Charts: **Apache ECharts only**. Never add Recharts, Chart.js or ApexCharts.
18. Tables: **TanStack Table + shadcn Table**.
19. Server state: **TanStack Query**.
20. Lightweight local UI state: **Zustand** only.
21. Web persisted non-sensitive cache: **IndexedDB**.
22. Mobile persisted non-sensitive cache: **AsyncStorage**; test-drive route buffer: local **SQLite**.
23. Backend/data/auth/realtime: **Supabase PostgreSQL + Auth + RLS + Edge Functions + Realtime**.
24. Large/private object storage: **Tigris Data S3-compatible object storage**. This is the current storage decision and overrides older PRD references to Supabase Storage.
25. Transactional email: **Brevo**.
26. Long-running/background jobs: **Trigger.dev**.
27. Mobile: **React Native + Expo + Expo Router** for Telecaller and Sales Consultant primary workflows only in MVP.
28. No native Kotlin unless a required capability cannot be delivered correctly with Expo/React Native.
29. Authentication primary factor: **email + password**. No phone-number login in MVP.
30. Privileged roles require **TOTP MFA** before access.
31. Code formatting: **Prettier**. TypeScript strict mode is mandatory.
32. Automated testing scope for MVP: **API/backend/integration tests only**. UI is manually verified against approved screenshots and acceptance flows; do not add Playwright/Cypress/component test suites unless explicitly requested later.
33. Never hard-delete business data from ordinary product actions. Use soft deletion, then controlled scheduled purge when policy allows.
34. External provider credentials/secrets are server-side only. Never expose plaintext secrets to the browser/mobile app.
35. All provider integrations are branch-scope aware and tenant-isolated.

---

## 1. Source precedence and implementation discipline

When requirements conflict, use this priority:

1. Latest explicit product-owner instruction.
2. This `AGENTS.md`.
3. Final/frozen role PRDs and operational PRD.
4. Approved screenshots as visual evidence.
5. Older screenshots/drafts only as historical reference.

Before implementing a provider integration, read the **current official provider documentation** for authentication, API versions, permissions/scopes, webhook verification, rate limits, token refresh, message windows/template rules, error/retry semantics and deprecations. Do not copy guessed API versions or permission names from memory. Keep provider versions/configuration isolated in adapters so upgrades do not leak through domain code.

> **Important:** API versions, OAuth scopes, messaging permissions and provider limits can change. Never hard-code an unverified provider version because a screenshot or old note mentioned it.

---

## 2. Product roles and authority

### 2.1 Platform

- **Super Admin**: Go Digital Marketing platform-level authority across dealership tenants.

### 2.2 Dealership executive/admin

- **Business Owner**: organization-wide executive visibility, company/compliance, Client Admin management, credits/usage visibility, support-session approval.
- **Client Admin**: primary dealership CRM/business configuration authority.
- **System Administrator**: delegated technical administrator within assigned scope.

### 2.3 Sales hierarchy

- **GM Sales Executive**
- **Showroom Manager**
- **Team Manager**
- **Sales Consultant**
- **Telecaller / BDC Executive**

Sales Consultant may receive an optional **Telecaller capability bundle** without creating a second user.

### 2.4 Operational departments

- Inventory Manager / Inventory Team
- Finance Manager / Finance Executives
- Insurance Manager / Insurance Executives
- RTO Manager / RTO Executive
- Used Car / Exchange Manager / Team
- Delivery Manager / Delivery Executives
- Customer Relationship Manager / CRM/Feedback Executives
- Marketing / Digital Marketing Manager / Campaign/Social Executives

Operational role names must not encode branch scope.

---

## 3. Approved technology stack

### Web

- Next.js + TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- TanStack Table
- TanStack Virtual only when it materially reduces DOM cost
- Zustand for lightweight UI state
- Apache ECharts for all charts
- IndexedDB for selected non-sensitive persisted cache
- React Hook Form + Zod are allowed for form/schema validation
- Lucide icons are allowed through the shadcn design language

### Backend

- Supabase PostgreSQL
- Supabase Auth
- Supabase Row Level Security
- Supabase Edge Functions
- Supabase Realtime
- PostgreSQL RPC/functions for transactional domain operations

### Object storage

- Tigris Data, using its current S3-compatible implementation and official configuration guidance
- Use S3-compatible adapters; application code must not depend on Tigris-specific object semantics where avoidable
- Generate short-lived presigned URLs server-side
- Large uploads/downloads should go directly between authorized client/provider and Tigris using presigned URLs whenever possible; do not proxy large files through Next.js or a short-lived Edge Function

### Email

- Brevo for platform transactional email
- Configure Supabase Auth custom SMTP through Brevo if supported by the current Supabase/Brevo configuration
- Application emails that require business logic go through an `EmailAdapter` and server-side Brevo integration

### Background work

- Trigger.dev for retries, schedules, long-running jobs, exports, AI jobs, provider ingestion that exceeds request-time work, file transfer/processing and retention purge workflows

### Mobile

- React Native + Expo + Expo Router
- AsyncStorage for selected non-sensitive persisted app state/cache
- SQLite for active test-drive route point buffering
- Use React Native primitives; **do not attempt to reuse DOM shadcn components in native mobile**

---

## 4. Repository structure

Prefer a simple repository. Do not introduce a monorepo framework unless the project already uses one.

```text
/
├─ src/
│  ├─ app/                         # Next.js routes/layouts
│  ├─ components/
│  │  ├─ ui/                       # shadcn generated/base components only
│  │  ├─ shared/                   # composed CRM components made only from shadcn/Tailwind
│  │  ├─ charts/                   # ECharts wrapper + chart presets
│  │  └─ domain/                   # reusable domain components
│  ├─ features/
│  │  ├─ auth/
│  │  ├─ customers/
│  │  ├─ leads/
│  │  ├─ calls/
│  │  ├─ appointments/
│  │  ├─ test-drives/
│  │  ├─ quotations/
│  │  ├─ bookings/
│  │  ├─ inventory/
│  │  ├─ finance/
│  │  ├─ insurance/
│  │  ├─ rto/
│  │  ├─ exchange/
│  │  ├─ delivery/
│  │  ├─ customer-care/
│  │  ├─ marketing/
│  │  ├─ administration/
│  │  └─ platform/
│  ├─ lib/
│  │  ├─ supabase/
│  │  ├─ permissions/
│  │  ├─ query/
│  │  ├─ validation/
│  │  ├─ providers/
│  │  ├─ storage/
│  │  ├─ credits/
│  │  └─ audit/
│  └─ config/
│     ├─ navigation/
│     ├─ role-presets/
│     └─ feature-flags/
├─ mobile/                         # Expo app
├─ supabase/
│  ├─ migrations/
│  ├─ seed.sql
│  └─ functions/
├─ trigger/                        # Trigger.dev jobs
├─ tests/
│  └─ api/                         # backend/API/provider integration tests only
├─ .prettierrc
├─ eslint.config.*
└─ AGENTS.md
```

Never place provider secrets in `NEXT_PUBLIC_*` variables.

---

## 5. UI and visual-system rules

### 5.1 Base UI

Use shadcn primitives as the only web component foundation:

`Sidebar`, `Card`, `Button`, `Badge`, `Table`, `Tabs`, `Input`, `Select`, `Command`, `Popover`, `Calendar`, `Dialog`, `AlertDialog`, `Sheet`, `DropdownMenu`, `Tooltip`, `Avatar`, `Checkbox`, `RadioGroup`, `Switch`, `Textarea`, `Progress`, `Separator`, `Accordion`, `ScrollArea`, `Skeleton`, `Form`.

Composed CRM components are required for reuse, but they must be built from shadcn + Tailwind rather than another UI library.

### 5.2 Visual layout

Approved screenshots establish this general layout language:

- desktop left navigation sidebar
- compact top application header
- neutral/clean business background
- KPI cards at the top
- 12-column responsive grid for dashboard content
- charts inside Cards
- filters above tables
- dense but readable enterprise tables
- status represented with shadcn Badges
- contextual detail usually in a full page or Sheet
- Dialog/AlertDialog for focused mutations/confirmations
- no decorative gradients unless the approved reference explicitly requires one
- do not use excessive shadows/animation

### 5.3 Charts

All charts use Apache ECharts through one reusable `EChart` wrapper.

Approved chart families:

- Line: time trends
- Bar: comparisons / target vs actual
- Donut: distribution/status breakdown
- Funnel: CRM pipeline

Maps are **not charts**. Use the configured Maps provider for maps/routes/GPS.

### 5.4 Dashboard pattern

Prefer:

```text
Page Header
KPI Card Grid
Requires Attention / Priority
1–2 useful charts (operational pages)
Up to 2–3 charts on analytical manager/executive pages
Main Table / Recent Activity
```

Do not add a chart when a table/list communicates the information better.

---

## 6. Reuse-first component strategy

Before creating any new component, check whether a shared component/preset can be extended.

### 6.1 Shared components

Create reusable composed components such as:

- `PageHeader`
- `KpiCard`
- `KpiGrid`
- `AttentionList`
- `FilterBar`
- `DataTableShell`
- `ServerPagination`
- `StatusBadge`
- `WorkStateBadge`
- `TemperatureBadge`
- `EntityHeader`
- `CustomerLink`
- `PhoneLink`
- `Timeline`
- `TimelineEvent`
- `NotesPanel`
- `DocumentsPanel`
- `DocumentUploader`
- `AssignmentDialog`
- `ReassignmentDialog`
- `FollowupDialog`
- `AppointmentDialog`
- `ApprovalSheet`
- `CallDetailSheet`
- `AudioPlayerCard`
- `AiReviewSheet`
- `CaseWorkflowStepper`
- `ScopeSelector`
- `BranchSelector`
- `TeamSelector`
- `UserSelector`
- `RoleSelector`
- `ProviderConnectionCard`
- `IntegrationHealthBadge`
- `CreditBalanceCard`
- `CreditLedgerTable`
- `SupportSessionBanner`
- `MaintenanceScreen`

### 6.2 Preset pattern

The same component should support different role presets rather than being copied.

Example:

```text
LeadTable
├─ TELECALLER preset
├─ SALES_CONSULTANT preset
├─ TEAM_MANAGER preset
├─ SHOWROOM_MANAGER preset
└─ GM_READ_ONLY preset
```

A preset controls:

- columns
- filters
- allowed actions
- query scope
- default sort
- bulk actions
- drill-down destination

Likewise:

```text
PerformanceDashboard
├─ PERSONAL
├─ TEAM
├─ SHOWROOM
├─ GM
└─ EXECUTIVE
```

and:

```text
CaseWorkspace
├─ FINANCE
├─ INSURANCE
├─ RTO
├─ EXCHANGE
└─ DELIVERY
```

Never fork a near-identical component just because the role name changed.

---

## 7. Authentication and account gating

### 7.1 Primary authentication

Use Supabase Auth:

- email + password
- no phone-number login in MVP
- secure password-reset email
- verified email workflow where appropriate

### 7.2 TOTP MFA

MFA gate happens **after valid email/password** and before privileged CRM access.

Mandatory by default for:

- Super Admin
- Business Owner
- Client Admin
- System Administrator
- GM Sales Executive
- any user with `ALL_BRANCHES` plus sensitive admin permissions
- any role explicitly marked `mfa_required` by policy

Optional/configurable initially for:

- Showroom Manager unless sensitive/all-branch policy requires it
- Team Manager
- Sales Consultant
- Telecaller/BDC
- ordinary operational executives

Never expose TOTP secret values after enrollment.

### 7.3 Access decision after login

A successful password/TOTP flow is not enough. Before rendering CRM, verify:

1. user is active
2. tenant is active
3. onboarding is approved
4. user has valid role assignment
5. required MFA assurance level is satisfied
6. tenant is not in support maintenance mode unless user is authorized for support control
7. account is not locked/suspended/deleted

### 7.4 Business Owner onboarding gate

New tenant lifecycle:

```text
Super Admin creates tenant + initial Business Owner
-> secure invite / temporary one-time access
-> owner sets/changes password
-> owner enrolls TOTP
-> owner enters company/legal/GST/dealer information
-> uploads required documents
-> submits
-> UNDER_REVIEW
-> Super Admin APPROVE / REQUEST_CHANGES / REJECT
-> ACTIVE
```

Until `ACTIVE`, do not render normal CRM modules.

### 7.5 Mobile QR linking

Telecaller and Sales Consultant should have **Link Mobile App** in the authenticated Web profile menu.

Rules:

- QR is a short-lived one-time backend challenge, never a password, refresh token or permanent session token
- challenge is tied to user, tenant, expiry and nonce
- mobile scans QR and exchanges the challenge through a Supabase Edge Function using the current supported Supabase Auth session-exchange mechanism
- challenge becomes invalid immediately after successful use
- revoke unused challenge on expiry
- mobile stores the resulting auth session using Expo secure storage mechanisms appropriate to Supabase Auth
- backup mobile login may use email + password; TOTP is required if that user's policy requires MFA

Do not invent a custom long-lived auth token system.

---

## 8. Tenancy, roles, permissions and scope

### 8.1 Data scope enum

At minimum:

```text
OWN_RECORDS
OWN_TEAM
ONE_BRANCH
SELECTED_BRANCHES
ALL_BRANCHES
ORGANIZATION
PLATFORM
```

Do not encode these into role names.

### 8.2 Scope selector rule

Exactly one branch-scope mode is active:

- `ONE_BRANCH`: exactly one branch ID
- `SELECTED_BRANCHES`: one or more branch IDs
- `ALL_BRANCHES`: no branch-selection array; selector disabled/cleared

Never store `ALL_BRANCHES` together with explicit selected branches.

### 8.3 Scope ceiling

A user who can create/manage another user may not grant a broader scope or higher delegated authority than allowed by their own role/permission ceiling.

### 8.4 Client Admin customer visibility

Primary/default Client Admin is organization-wide and can see all customers across all branches of that tenant. Additional delegated Client Admins may be branch-scoped if explicitly configured.

### 8.5 Business Owner scope

Business Owner is normally `ORGANIZATION` scope, executive/read-heavy.

### 8.6 RLS

Every tenant-owned table must include `organization_id` and be protected by RLS.

Branch/team scoped tables include the relevant `branch_id`/`team_id`.

Policies conceptually enforce:

```text
organization match
AND required permission
AND branch access
AND team/record scope where applicable
```

Frontend button hiding is not security.

Never ship Supabase `service_role` credentials to the browser or mobile app.

---

## 9. Core data invariants

### 9.1 Customer and lead

- `customers.id`: UUID primary key
- `leads.id`: UUID primary key
- `leads.customer_id`: nullable until matched/created, then references customer
- one customer -> many leads
- one customer -> many bookings/purchases
- one customer -> many vehicles

Normalize and index phone numbers, but do not make phone globally unique.

### 9.2 Canonical lead source

Current canonical values include:

- Facebook
- Instagram
- Google Ads
- Website
- WhatsApp Business
- CarWale
- CarDekho
- Justdial
- IndiaMART
- Manual
- Other

Store separately:

- source
- source_detail/provider
- campaign
- external_lead_id
- raw source payload reference/data for traceability

### 9.3 Incoming lead minimum fields

Required for normal lead ingestion:

- source
- customer name
- phone

Optional/source-dependent:

- email
- location
- campaign
- interested model
- preferred branch
- source detail
- external lead ID

### 9.4 Lead lifecycle vs work-state

Lifecycle:

- New
- Contacted
- Qualified
- Appointment Scheduled
- Transferred to Sales
- Lost

Sales-stage events can include:

- Test Drive
- Quotation
- Booking

Derived work-state:

- New Today
- Pending
- SLA Risk

Never persist an automatic `Pending` lifecycle transition just because 24 hours passed.

### 9.5 Customer 360

Customer 360 is contextual, not a normal sidebar page. It can expose permission-filtered sections:

- Overview
- Leads
- Calls
- Conversations
- Follow-ups
- Appointments
- Test Drives
- Quotations
- Bookings
- Vehicles
- Exchange
- Finance
- Insurance
- RTO
- Delivery
- Customer Care
- Documents
- Timeline

### 9.6 Operational linking

Customer-related operations use:

```text
customer_id
+ booking_id
+ department case ID
+ vehicle_id / VIN when applicable
```

Examples:

- `finance_case_id`
- `insurance_case_id`
- `rto_case_id`
- `exchange_request_id`
- `delivery_id`
- `allocation_id`

Inventory can exist before a customer and is primarily anchored by `vehicle_id` / VIN / chassis.

---

## 10. Database table families

Use migrations; never create production tables manually through dashboard-only changes.

### Tenancy / identity

- organizations
- branches
- profiles/users
- roles
- permissions
- role_permissions
- user_role_assignments
- user_branch_access
- teams
- team_members

### Module/entitlement

- modules
- subscription_plans
- plan_modules
- organization_module_entitlements
- module_usage

### CRM

- customers
- customer_contacts
- customer_addresses
- customer_vehicles
- leads
- lead_sources
- lead_assignments
- lead_assignment_history
- lead_stage_history
- lead_temperature_history
- custom_field_definitions
- custom_field_values
- notes
- activities

### Work

- followups
- reminders
- tasks (shared engine; only surface where product requires it)
- appointments

### Calls / messaging / AI

- calls
- call_recordings
- call_transcripts
- conversations
- conversation_messages
- ai_call_summaries
- ai_extraction_runs
- ai_field_reviews
- ai_credit_ledger
- tracking_credit_ledger

### Test drive

- test_drive_appointments
- test_drives
- test_drive_route_summaries
- test_drive_route_points (simplified/persisted points only)
- test_drive_feedback
- live_tracking_sessions

### Sales / stock

- vehicle_brands
- vehicle_models
- vehicle_variants
- stock_units
- stock_movements
- stock_allocations
- quotations
- quotation_items
- quotation_versions
- bookings
- booking_status_history

### Operations

- exchange_cases
- exchange_evaluations
- finance_cases
- finance_case_documents
- insurance_cases
- insurance_case_documents
- rto_cases
- rto_case_documents
- delivery_cases
- delivery_checklist_items
- feedback_requests
- complaints
- escalations

### Integrations / system

- tenant_installations
- connected_accounts
- integration_credentials (server-only access)
- integration_branch_mappings
- integration_field_mappings
- webhooks/provider_events
- sync_runs
- error_logs
- automation_rules
- automation_runs
- templates
- alert_rules
- audit_logs
- support_access_requests
- support_sessions
- tenant_status_history
- deletion_requests
- purge_jobs
- object_files

Names may be refined, but do not collapse unrelated concepts into one giant table.

---

## 11. Query architecture and production performance

### 11.1 General rule

No page loads a full tenant dataset into the browser.

All large tables use server-side:

- filtering
- sorting
- pagination
- search

Default page size: `25`.
Options: `25 / 50 / 100`.

### 11.2 Page-local search

Search only the current resource.

Examples:

- Team Leads: lead ID, customer name, normalized phone
- Users: name, email, phone, employee ID
- Inventory: VIN, model, registration
- Operations: case ID, booking ID, customer

Do not build one global `%term%` query across all CRM tables.

### 11.3 Debounce

Search input: approximately `300ms` debounce.
Cancel obsolete queries and only send the latest request.

### 11.4 Indexing

Always index real query patterns, starting with tenant/scope columns.

Typical B-tree/composite patterns:

```text
(organization_id, created_at DESC)
(organization_id, branch_id, created_at DESC)
(organization_id, team_id, created_at DESC)
(organization_id, assigned_user_id, status, created_at DESC)
(organization_id, branch_id, lifecycle_status, created_at DESC)
(organization_id, next_followup_at)
(organization_id, normalized_phone)
(organization_id, booking_id)
(organization_id, provider_connection_id, provider_event_id)
```

Use PostgreSQL `pg_trgm` + GIN for fuzzy name searches where needed, especially customer/user/dealership names.

Do not add trigram indexes to every text column.

### 11.5 Pagination strategy

- ordinary CRM tables: normal server-side page pagination is acceptable
- very high-volume logs/audit/provider events: prefer keyset/cursor pagination by `(created_at, id)`
- never `SELECT *` for list pages
- fetch only visible/list-required columns

### 11.6 Counts and dashboard aggregates

Do not execute expensive multi-table counts independently for every KPI card on every render.

Prefer:

- one SQL RPC/view returning the page's KPI bundle
- indexed aggregate queries
- pre-aggregated daily metrics tables for expensive platform/executive analytics where needed

Dashboard query should return all top KPI data in as few round trips as practical.

### 11.7 Avoid N+1

List queries should join/select required display data in one query/RPC rather than making one request per row.

### 11.8 TanStack Query defaults

```text
staleTime = 60 seconds
gcTime = 30 minutes
refetchOnWindowFocus = false
refetchOnReconnect = true
```

Manual refresh limit:

`3 refreshes / minute / user / page-resource`.

Query keys must include resource + tenant/scope + filters + sort + page.

Example:

```text
['team-leads', organizationId, scopeHash, filters, sort, page]
```

Mutations invalidate only affected keys.

### 11.9 Virtualization

Use TanStack Virtual only for genuinely high-density views:

- 100-row tables where DOM cost is visible
- long timelines
- long logs
- large user/permission selectors
- long transcript/event streams

Do not virtualize a normal 25-row table.

---

## 12. Backend boundary: Supabase first

### 12.1 Do not duplicate backend logic in Next.js

Next.js is primarily the web application/UI layer.

Do not create a parallel business-API architecture in Next.js route handlers when Supabase is already the backend.

### 12.2 Simple data access

Authenticated simple reads/writes may use the Supabase client with RLS.

### 12.3 Atomic business operations

Use PostgreSQL RPC/functions for multi-table atomic operations such as:

- lead assignment/reassignment
- customer link/create decision
- booking creation
- stock allocation
- approval transitions
- credit reservation/consumption
- support session state changes

### 12.4 External/provider API boundary

All secret-bearing external provider API calls and provider webhooks are handled through **Supabase Edge Functions** or background workers invoked from them.

Browser/mobile must never call provider APIs using provider secrets.

### 12.5 Heavy work rule

Supabase Edge Function is the **ingress/orchestration boundary**, not an excuse to run unbounded work inside a request.

For long-running work:

```text
Client/provider -> Supabase Edge Function
-> authenticate/validate/idempotency
-> enqueue Trigger.dev job
-> return quickly
-> Trigger.dev performs long job/retries
-> write final result to Supabase/Tigris
```

Use this for:

- large provider syncs
- large call recording downloads
- transcript/AI jobs
- bulk imports
- exports/reports
- scheduled automations
- retry loops
- retention purge

This keeps the product within Edge Function execution limits while preserving Supabase as the controlled API boundary.

---

## 13. Edge Function inventory

Create focused functions; do not build one giant `api` function.

Suggested functions:

- `lead-ingest`
- `integration-oauth-start`
- `integration-oauth-callback`
- `integration-test`
- `provider-webhook-meta`
- `provider-webhook-whatsapp`
- `provider-webhook-ivr`
- `provider-webhook-generic`
- `provider-sync-call`
- `provider-sync-leads`
- `send-message`
- `send-email`
- `presign-upload`
- `presign-download`
- `mobile-link-create`
- `mobile-link-exchange`
- `support-session-request`
- `support-session-accept`
- `support-session-end`
- `credit-consume`

Each function must:

1. validate auth/signature
2. resolve tenant/connection
3. validate scope/permission
4. validate payload with a schema
5. enforce idempotency where applicable
6. perform small work or enqueue background job
7. write audit/log record
8. return a typed response

---

## 14. Provider adapter architecture

Never scatter provider-specific code through React pages or domain services.

Use interfaces/adapters such as:

```ts
interface LeadSourceAdapter {
  testConnection(connectionId: string): Promise<ConnectionTestResult>
  normalizeWebhook(input: unknown, ctx: AdapterContext): Promise<CanonicalLeadInput[]>
  pullLeads?(cursor?: string): Promise<PullResult>
}

interface MessagingAdapter {
  sendMessage(input: SendMessageInput): Promise<ProviderMessageResult>
  normalizeInbound(input: unknown, ctx: AdapterContext): Promise<CanonicalMessage[]>
}

interface CallProviderAdapter {
  startCall?(input: StartCallInput): Promise<ProviderCallRef>
  fetchCall(providerCallId: string): Promise<ProviderCallResult>
  fetchRecording?(providerCallId: string): Promise<ProviderRecordingRef>
  fetchTranscript?(providerCallId: string): Promise<ProviderTranscript>
}

interface EmailAdapter {
  send(input: EmailInput): Promise<EmailResult>
}

interface MapsAdapter {
  geocode(...): Promise<...>
  route(...): Promise<...>
}

interface AIAdapter {
  transcribe(...): Promise<...>
  summarize(...): Promise<...>
  extractFields(...): Promise<...>
}
```

Provider code belongs under `src/lib/providers` and/or server/Edge shared modules.

---

## 15. Integration ownership and branch mapping

### 15.1 Who connects tenant providers

Primary:

- Client Admin

Allowed when permission is granted:

- System Administrator
- Digital Marketing Manager for limited marketing/campaign connection workflows

Super Admin manages platform adapters/provider health and may configure a tenant connection only inside an approved support session.

### 15.2 Connection scope

Each connection has:

- `ONE_BRANCH`
- `SELECTED_BRANCHES`
- `ALL_BRANCHES`

Store branch mapping separately in `integration_branch_mappings`.

Examples:

- GBP Location A -> Branch A
- GBP Location B -> Branch B
- Google Ads Account -> All Branches
- Meta Account -> Branch A + Branch B
- WhatsApp Business Number -> Branch A
- IVR connection -> selected branches

One shared provider account may map campaigns/pages/locations/numbers to branches; separate branch accounts are also supported.

### 15.3 Provider credential rules

- platform secrets: Supabase project/Edge secrets
- tenant dynamic OAuth tokens/credentials: dedicated encrypted server-only store/table; only service-role/backend can read decrypted values
- browser sees masked value/status only
- expose `Replace credential`, never `Reveal secret`
- log credential replacement, never secret contents

---

## 16. Provider-specific product expectations

Do not hard-code current API version/scopes here; verify current official docs at implementation time.

### Meta / Facebook / Instagram

Support product adapters for:

- Facebook/Meta Lead Ads ingestion
- Facebook Messenger where the connected business asset and current API permissions support it
- Instagram Messaging where the connected professional account and current API permissions support it
- social publishing/analytics only where current official APIs and permissions allow

Normalize all external leads/messages into canonical CRM entities.

### WhatsApp

For tracked CRM WhatsApp use the **official WhatsApp Business Platform/API**.

- store permitted inbound/outbound conversation history
- respect current conversation/template rules from official docs
- do not promise normal/personal WhatsApp sync

If an employee uses personal/normal WhatsApp externally, record only a manual communication event: channel, mode=`MANUAL`, user, timestamp, note.

### Google Ads

- OAuth-based tenant connection
- campaign/account mapping to one/selected/all branches
- lead/performance sync only from fields officially available
- never assume price/spend fields exist in every provider payload

### Google Business Profile

Map actual connected business locations to CRM branches.

### IVR/calling provider

- provider call ID is the idempotency key per connection
- sync metadata/recording/transcript server-side
- provider recording URL is temporary input, not the permanent CRM source
- ingest final recording to Tigris

### Brevo

- platform transactional email and auth-email delivery
- platform API key is Super Admin/platform configuration, not a branch-level secret
- tenant/branch sender profiles may be configured as business metadata where supported/verified

---

## 17. Tigris object-storage rules

Use Tigris for:

- call recordings
- customer/operational documents
- insurance/finance/RTO files
- vehicle/exchange photos
- delivery photos/signatures
- generated reports/exports
- AI generated files when needed

Create an `object_files` metadata record:

```text
id
organization_id
branch_id nullable
resource_type
resource_id
bucket
object_key
mime_type
size_bytes
checksum
uploaded_by
created_at
deleted_at nullable
```

### Security

- bucket is private
- uploads/downloads use short-lived presigned URLs
- URL generation happens server-side after RLS/permission check
- never persist a presigned URL as the canonical object reference
- validate mime, extension, max size and resource ownership before presign/finalization
- for uploads, finalize metadata only after object exists/has expected properties

### Large provider recording ingestion

```text
Sync requested
-> Edge Function validates
-> Trigger.dev downloads provider recording
-> streams/uploads to Tigris
-> stores object_files + call_recordings metadata
-> marks sync complete
```

Avoid loading a large audio file fully into memory.

---

## 18. Brevo email rules

Use Brevo for:

- Business Owner invite/setup email
- Client Admin/user invite email
- password-reset/transactional auth email through Supabase Auth custom SMTP where supported
- reports ready email
- critical system/admin notices
- application transactional email through EmailAdapter

Email sending is always server-side.

Do not use Brevo API directly from browser/mobile.

Store:

- application message ID
- provider message ID
- template ID
- recipient
- status
- timestamps
- error code/message (sanitized)

Never store the Brevo secret in tenant-readable tables.

---

## 19. Call recording and AI workflow

### Provider call

```text
User initiates call / provider call exists
-> CRM stores pending call
-> provider callback or Sync Call
-> Edge Function validates
-> Trigger.dev sync job if needed
-> recording copied to Tigris
-> transcript stored/reference created
-> AI summary/extraction only on explicit eligible action/policy
```

### Personal call

Telecaller/Sales Consultant may upload a recording file manually if they called outside integrated IVR.

Do not assume the mobile app can automatically record normal cellular calls.

### AI review

AI can suggest:

- model/variant
- budget
- purchase timeline
- finance required
- exchange required
- test drive required
- follow-up date
- competitor mention
- customer intent

AI must never silently overwrite CRM fields.

Use:

`Suggest -> Review -> Select/Edit -> Apply Selected Changes`.

Audit the extraction run and field review.

---

## 20. Credit ledgers

Maintain separate append-only ledgers:

- AI credits
- tracking credits (if enabled)

Never overwrite a balance as the only source of truth.

Each ledger transaction records:

- organization
- transaction type: allocation / consumption / adjustment / reversal
- amount
- feature
- user/source
- reference ID
- reason
- created_by
- timestamp

Balance is derived transactionally.

Credit consumption must use an atomic PostgreSQL RPC to prevent overspending under concurrency.

Existing saved AI output can be viewed without consuming new credits; generation/regeneration consumes credits.

---

## 21. Test-drive GPS architecture

Mobile is the primary active test-drive client.

### Default route tracking

- Expo background location
- local SQLite route buffer
- immediately persist server anchors: start, reached destination if used, end
- do not continuously write every GPS point to PostgreSQL

Persist:

- start lat/lng/time/odometer
- reached lat/lng/time if used
- end lat/lng/time/odometer
- duration
- distance
- simplified route summary after completion

### Manager tracking

Team Manager and Showroom Manager can request location only for active drives within scope.

Normal view:

- current snapshot on demand
- optional low-frequency refresh while viewing (target around 10 minutes)

Real-Time Boost:

- explicit action
- lasts 1 minute
- approx. 5–10 second updates as device/network permits
- use Supabase Realtime Broadcast, not a PostgreSQL insert for every ping
- auto-stop
- may consume tracking credits

If device cannot respond, show `Live Location Unavailable` + last known timestamp. Never label stale data as live.

GM / Client Admin / Business Owner default to completed route/anchor summary rather than continuous live tracking.

---

## 22. Communication model

### Tracked sales conversations

Telecaller/Sales Consultant may use connected:

- WhatsApp Business Platform
- Facebook Messenger
- Instagram Messaging

only when the tenant connection and current provider permissions support it.

Conversation history attaches to Lead/Customer timeline.

### Operational communication

Operational departments do not require a heavy inbox by default.

If a connected channel exists:

`Notify Customer -> approved template/channel -> provider -> delivery/status logged`.

If the employee communicates externally:

`Mark as Sent / Mark as Contacted` with:

- channel
- mode = MANUAL
- user
- timestamp
- optional note

Never pretend a manually marked message was delivered by CRM.

---

## 23. Assignment engine

### Fresh lead

```text
Incoming lead
-> branch/team routing
-> Telecaller queue
```

### Qualified lead

```text
Telecaller qualifies
-> team assignment mode
-> Round Robin OR Manual Sales Consultant selection
-> Sales Consultant assigned
```

Team Manager controls the team assignment mode.

Showroom Manager can override/reassign within authorized scope.

Every assignment record stores:

- previous owner
- new owner
- assigned by
- method
- reason
- branch/team
- timestamp

Hybrid Sales Consultant + Telecaller user can keep ownership after qualification instead of transferring to themselves.

---

## 24. Role navigation and page presets

### 24.1 Telecaller / BDC — Web

Sidebar:

1. Dashboard
2. New Leads
3. My Leads
4. Follow-ups
5. Tasks
6. Calls
7. Appointments
8. Performance

Contextual: Lead/Customer Detail.

Performance is personal only.

### Telecaller — Mobile

Bottom navigation:

1. Home
2. My Leads
3. Follow-ups
4. Tasks

Contextual: Lead Detail.

No large mobile analytics.

### 24.2 Sales Consultant — Web

1. Dashboard
2. My Leads
3. Follow-ups
4. Tasks
5. Calls
6. Appointments
7. Test Drives
8. Quotations
9. Stock Check
10. Exchange
11. Bookings
12. Performance

If Telecaller capability bundle is enabled, add **New Leads**.

Contextual:

- Customer 360
- conversation
- competitor comparison
- create quotation
- create/active test drive
- test-drive feedback
- booking detail

### Sales Consultant — Mobile

1. Home
2. My Leads
3. Follow-ups
4. Appointments
5. Test Drives
6. Tasks

Contextual: Customer Detail.

### 24.3 Team Manager — Web only

1. Dashboard
2. Team Leads
3. Lead Assignment
4. Follow-ups
5. Team Calls
6. Appointments
7. Test Drives
8. Quotations
9. Bookings
10. Team Performance
11. Lost Leads
12. Escalations
13. Reports

No Team Leader. Team Manager directly manages Telecaller + Sales Consultant.

No separate Tasks page in MVP.

### 24.4 Showroom Manager — Web only

1. Dashboard
2. Showroom Leads
3. Lead Assignment
4. Follow-ups
5. Team Calls
6. Appointments
7. Test Drives
8. Quotations
9. Bookings
10. Approvals
11. Sales Teams
12. Showroom Targets
13. Performance
14. Lost Leads
15. Escalations
16. Reports
17. Users — optional, permission based

### 24.5 GM Sales Executive — Web only

1. Dashboard
2. Sales Leads
3. Showroom Comparison
4. Sales Performance
5. Sales Consultant Ranking
6. Lead Source Performance
7. Model Performance
8. Targets
9. Approvals
10. Bookings Overview
11. Lost Leads
12. Escalations
13. Reports
14. Users — optional, delegated

GM Sales Leads is read-only by default and focuses on qualified sales opportunities onward.

### 24.6 Client Admin — Web only

1. Dashboard
2. Branches
3. Teams
4. Users
5. Roles & Permissions
6. Lead & Assignment Settings
7. CRM Configuration
8. Custom Fields
9. Integrations
10. Modules & Access
11. Targets & Approval Rules
12. AI & Usage
13. Audit Logs
14. Reports

### 24.7 System Administrator — Web only

1. Dashboard
2. Users
3. Roles & Permissions
4. Branches & Access
5. Master Data
6. Integrations
7. Automation Rules
8. Templates
9. Alerts & Notifications
10. System Health
11. Audit Logs
12. Backup & Data Management
13. Security
14. Reports

System Administrator actions are delegated by Client Admin and cannot exceed assigned scope.

### 24.8 Business Owner — Web only

1. Dashboard
2. Sales Overview
3. Showroom Performance
4. Operations Overview
5. Bookings & Delivery
6. Targets & Performance
7. AI Business Summary
8. Reports
9. Client Admins
10. Company & Compliance
11. Credits & Usage
12. Support & Maintenance
13. Security & Access

Business Owner is executive/read-heavy and can create/manage Client Admins.

### 24.9 Super Admin — Web only

1. Dashboard
2. Dealerships
3. Onboarding Reviews
4. Business Owners
5. Plans & Features
6. Modules & Entitlements
7. Credits & Usage
8. Integrations & Providers
9. Support Sessions
10. Platform Health
11. Users & Access
12. Security
13. Audit Logs
14. Data Retention & Deletion
15. Platform Settings
16. Reports

Super Admin is platform-level and does not normally work dealership leads.

---

## 25. Operational department presets

Operational UI is intentionally simpler than Sales.

Default pattern:

`Dashboard -> Work Queue/List -> Case Detail -> Documents -> Workflow -> Reports`.

### Inventory

Sidebar:

- Dashboard
- Vehicle Inventory
- Stock Allocation
- Stock Ageing
- Stock Transfer
- Reports
- My Performance

Primary owner of physical stock, VIN/chassis, allocation and movement.

### Finance

Sidebar:

- Dashboard
- Finance Cases
- Pending Documents
- Applications
- Disbursement
- Reports
- My Performance

Workflow:

`Finance Required -> Documents -> Application Submitted -> Approval/Query/Rejected -> Disbursement -> Completed`.

### Insurance

Default simple sidebar:

- Dashboard
- Insurance Cases
- Reports
- My Performance

Optional modules:

- Renewals
- Claims
- Insurer Directory

### RTO

Sidebar:

- Dashboard
- RTO Cases
- Reports
- My Performance

RTO Cases tabs:

- New
- Documents Pending
- Submitted
- Registration Pending
- Number Allocation
- Completed

Exact legal/document requirements are configuration, not hard-coded assumptions.

### Used Car / Exchange

- Dashboard
- Exchange Requests
- Evaluations
- Accepted Exchanges
- Reports
- My Performance

### Delivery

Full optional sidebar:

- Dashboard
- Upcoming Deliveries
- Delivery Planner
- Pending Checklist
- Ready for Delivery
- Delivered
- Delivery Photos
- Feedback
- Reports
- My Performance

Simple client may use only Dashboard / Deliveries / Reports with tabs.

### Customer Relationship

- Dashboard
- Customer Cases
- Follow-ups
- Feedback
- Reviews
- Complaints & Escalations
- Reports
- My Performance

### Digital Marketing

- Dashboard
- Lead Sources
- Campaigns
- Social Posts
- Reviews
- AI Content / Image
- Performance
- Reports

Provider secret/configuration remains primarily Client Admin/System Admin responsibility.

---

## 26. Core business workflows

### Lead-to-booking

```text
External/Manual Lead
-> mapping/validation/normalization
-> canonical Lead
-> branch/team assignment
-> Telecaller contact/qualification
-> Customer match/create
-> Qualified
-> Sales Consultant assignment
-> Follow-up / Showroom Visit / Test Drive
-> Quotation
-> Stock Check / Exchange as required
-> Booking
```

Appointment is not mandatory for qualification.

### Post-booking operations

```text
Booking Confirmed
-> Vehicle Allocation
-> Finance if required
-> Insurance
-> RTO
-> Accessories / PDI / Documents
-> Ready for Delivery
-> Delivered
-> Customer Relationship / Feedback / Review
```

Operational stages may overlap when business rules allow; do not force one rigid serial transaction unless the configured workflow requires it.

### Department ownership

- physical vehicle stock/allocation: Inventory
- loan processing: Finance
- policy: Insurance
- registration: RTO
- exchange valuation: Exchange
- delivery readiness/handover: Delivery
- post-sale customer care: Customer Relationship
- campaign/source performance: Digital Marketing
- customer-facing sales owner: Sales Consultant
- showroom coordination: Showroom Manager
- multi-showroom sales oversight: GM
- dealership configuration/access: Client Admin

---

## 27. Approvals and targets

### Targets

Client Admin configures available target metrics.

GM allocates showroom-level targets.

Showroom Manager distributes targets to Team Managers/teams.

Possible metrics:

- leads
- qualified leads
- test drives
- quotations
- bookings
- deliveries
- revenue/booking value

### Approvals

Approval routing is configurable.

Example:

`Sales Consultant -> Showroom Manager -> GM -> configured higher authority`.

Use approval records containing:

- type
- resource
- requested change/value
- requester
- current approver
- authority limit
- status
- timestamps
- comments/history

Do not hard-code example rupee limits into production defaults unless configured.

---

## 28. Customer/business communications and timeline

All important customer activity writes a timeline event.

Examples:

- lead created
- customer linked
- call
- recording uploaded
- call synced
- WhatsApp/Messenger/Instagram message
- note
- follow-up
- appointment
- test drive
- quotation
- booking
- stock allocation
- finance status
- insurance policy
- RTO status
- delivery status
- feedback/review
- assignment/transfer
- manager override

Timeline access is permission-filtered but the underlying history should remain complete.

---

## 29. Audit architecture

Audit at minimum:

- user created/disabled
- role/permission/scope change
- branch/team change
- assignment/reassignment
- customer merge/link decision
- integration connection/credential replacement
- provider sync failure/retry
- workflow status change
- document upload/remove
- approval action
- stock allocation/transfer
- finance/insurance/RTO/delivery transitions
- credit allocation/consumption adjustment
- support session actions
- soft delete/restore/purge
- security/MFA/session changes

Audit rows are effectively immutable from normal application UI.

Do not log secrets, raw passwords, MFA seeds or full provider tokens.

---

## 30. Soft deletion and purge

Ordinary deletion is soft deletion.

Recommended columns:

```text
deleted_at
deleted_by
deletion_reason
purge_after
```

For a tenant soft delete:

- block login
- disable integrations/jobs
- hide from active lists
- preserve data
- allow restore before purge if policy permits

Permanent purge is a controlled Trigger.dev scheduled workflow after retention eligibility checks.

Purge must be idempotent, auditable and remove Tigris objects as part of controlled cleanup.

---

## 31. Super Admin support-access session

Never implement hidden impersonation.

Flow:

```text
Super Admin requests support access
-> Business Owner or authorized Client Admin accepts
-> tenant enters SUPPORT_MAINTENANCE
-> normal tenant users see maintenance screen and cannot CRUD
-> owner/admin sees support control/status screen
-> Super Admin enters clearly labeled tenant support context
-> session max 1 hour
-> full audit
-> either party can end early
-> auto-expire
-> tenant ACTIVE again
```

Support session stores:

- tenant
- requester
- approver
- purpose
- allowed capability scope
- start/expiry/end
- every support action
- termination reason

Support session must not reveal passwords, MFA secrets or provider secrets.

---

## 32. Business Owner onboarding and tenant status

Tenant statuses should support at least:

- ONBOARDING
- UNDER_REVIEW
- CHANGES_REQUIRED
- ACTIVE
- SUPPORT_MAINTENANCE
- SUSPENDED
- REJECTED
- SOFT_DELETED

A normal tenant user must not bypass status gating by typing a route directly.

---

## 33. Error, loading and empty states

Every page must implement:

- skeleton/loading state
- no-data empty state
- permission denied state
- tenant/scope empty state
- retryable error state
- unrecoverable error state with reference ID

Provider failures should show sanitized error text and a log/reference ID, not raw secret-bearing provider payloads.

Use shadcn `Skeleton`, `Alert`, `Card`, `Button`, `Badge` patterns.

---

## 34. Form and validation rules

- validate client-side for UX and server-side for security
- Zod/shared schemas are preferred for request validation
- never trust enum strings from browser without validation
- trim/normalize user input
- normalize phone before matching/search
- never trust branch/team IDs from browser; server re-validates scope
- optimistic updates only when rollback is safe and domain semantics are clear
- destructive/financial/approval actions require explicit confirmation

---

## 35. API response conventions

Use consistent JSON envelopes for Edge Functions:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "request_id": "uuid"
}
```

Failure:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "INTEGRATION_CONNECTION_FAILED",
    "message": "Safe user-facing message"
  },
  "request_id": "uuid"
}
```

Do not leak stack traces or provider secrets to clients.

Use stable error codes.

---

## 36. Idempotency rules

Required for provider-facing and critical mutation flows.

Examples:

- external lead: unique `(organization_id, connection_id, external_lead_id)` where available
- provider webhook: unique provider event ID/hash per connection
- call: unique `(organization_id, connection_id, provider_call_id)`
- payment/credit allocation: explicit idempotency key/reference
- booking creation from quotation: transaction + uniqueness guard

Duplicate webhook delivery must be safe.

---

## 37. Security checklist

- RLS enabled on tenant tables
- no service-role key client-side
- no provider secrets client-side
- no plaintext password storage
- no MFA secret display
- short-lived presigned Tigris URLs
- webhook signature verification
- OAuth `state` validation and PKCE/official recommended flow where applicable
- token refresh server-side
- rate limits on public ingestion endpoints
- idempotency on provider webhooks
- audit privileged actions
- soft-delete by default
- sanitize logs
- validate file type/size
- use least privilege for provider scopes
- do not allow a manager to create users above delegation ceiling

---

## 38. Rate limiting

At minimum rate-limit:

- login-sensitive custom endpoints
- lead ingestion endpoints
- provider test endpoints
- manual refresh endpoints if custom
- message sending
- AI generation
- support session requests
- presign endpoints

Manual page refresh rule remains `3/minute/user/page-resource`.

Server-side shared limits may use a managed rate-limit store if introduced; do not store critical distributed rate limits only in browser memory.

---

## 39. Mobile rules

MVP mobile is intentionally small.

Primary users:

- Telecaller
- Sales Consultant

Mobile is for daily field work, not manager analytics.

Do not duplicate every web page on mobile.

Required characteristics:

- fast lists/cards
- Call and WhatsApp quick actions
- follow-up/task actions
- customer detail
- Sales test-drive workflow/GPS
- offline-tolerant selected cache
- explicit sync state where needed
- no ECharts requirement in mobile MVP

---

## 40. Testing policy

User requirement: automated tests focus on **API/backend**, not UI.

### Required API/backend tests

Test at minimum:

- lead ingestion mapping/validation
- duplicate provider webhook idempotency
- tenant isolation and scope authorization
- role/permission denial cases
- Round Robin/manual assignment rules
- customer link/create flow
- booking/stock allocation transactional operations
- integration test endpoints
- provider webhook signature validation
- call sync idempotency
- credit ledger atomic consumption
- support session lifecycle/expiry/authorization
- soft delete/restore/purge eligibility
- presigned Tigris access authorization
- AI apply-review authorization

### Provider adapter tests

Use mocked official provider responses for unit/API tests; include success, auth failure, rate limit, malformed payload and retryable server error.

### No automated UI tests in MVP

Do not add Playwright, Cypress or React component test suites unless explicitly requested.

Manual UI QA must compare:

- approved screenshot layout
- sidebar/page names
- permissions/action visibility
- responsive desktop behavior
- loading/empty/error states
- form validation
- actual ECharts rendering

---

## 41. Code quality

### TypeScript

- `strict: true`
- avoid `any`
- validate external data at boundaries
- keep domain types separate from provider payload types
- use discriminated unions for statuses when useful

### Formatting

Use Prettier.

Recommended baseline:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

Use `prettier-plugin-tailwindcss` if compatible with the chosen current stack.

### Linting

ESLint must pass.

No unused imports, dead code, swallowed errors or debug logs in committed production code.

### Commands

Prefer project scripts:

```text
format
format:check
lint
typecheck
test:api
build
```

An implementation task is not complete until relevant scripts pass.

---

## 42. Environment variable policy

Examples only; exact names may be adjusted consistently.

Public:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Server-only:

```text
SUPABASE_SERVICE_ROLE_KEY
TIGRIS_ENDPOINT
TIGRIS_REGION
TIGRIS_BUCKET
TIGRIS_ACCESS_KEY_ID
TIGRIS_SECRET_ACCESS_KEY
BREVO_API_KEY
TRIGGER_SECRET_KEY
INTEGRATION_ENCRYPTION_KEY
META_APP_ID
META_APP_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
...
```

Never prefix a secret with `NEXT_PUBLIC_`.

Provider credentials that vary by tenant should be stored encrypted in server-only tenant credential storage, not as one environment variable per tenant.

---

## 43. Data privacy and least exposure

List/table endpoints must return only columns needed by that role/page.

Examples:

- GM Sales Leads: read-only sales-opportunity fields; do not expose unnecessary sensitive customer data
- Team Manager: team-scoped leads only
- Sales Consultant: assigned customer context
- Telecaller: own/assigned new queue + linked customer context
- Operational user: only cases in assigned module/scope
- Business Owner: executive read-heavy view

Do not use `select('*')` in production list queries.

---

## 44. Reporting and exports

- charts use ECharts
- heavy report generation runs in Trigger.dev
- output file stored privately in Tigris
- user gets short-lived download URL after authorization
- report generation is auditable
- report queries must enforce tenant/scope

---

## 45. Notification/event architecture

Use domain events for cross-department handoffs.

Examples:

- `booking.confirmed`
- `vehicle.allocated`
- `finance.approved`
- `insurance.ready`
- `rto.completed`
- `delivery.ready`
- `delivery.completed`

Critical state change and event/outbox record should be created in the same transaction where reliability matters.

Trigger.dev can consume/process asynchronous notification work.

---

## 46. Provider implementation checklist

Before marking a provider as implemented:

1. read current official docs
2. confirm authentication method
3. confirm API version strategy
4. confirm required permissions/scopes
5. confirm webhook verification/signature
6. implement OAuth token refresh if applicable
7. implement idempotency
8. implement retry classification
9. implement rate-limit handling/backoff
10. map external entities to canonical CRM schema
11. store raw provider IDs for traceability
12. implement branch mapping
13. implement `Test Connection`
14. implement safe disconnect/reconnect
15. mask secrets
16. add API tests
17. add sanitized error logging
18. add audit entries

Do not mark a provider complete because a sandbox call succeeded once.

---

## 47. Definition of Done for a page

A page is done only when:

- route/sidebar permission is correct
- role preset is correct
- scope/RLS is correct
- shadcn-only UI is used
- ECharts is used for any chart
- tables are server-paginated where needed
- search is debounced/index-backed
- loading/empty/error states exist
- mutation permission is server-validated
- audit is written for privileged mutations
- relevant TanStack Query keys invalidate correctly
- no secret is exposed
- API tests exist for new backend behavior
- Prettier/lint/typecheck pass
- UI manually matches approved reference design

---

## 48. Definition of Done for an integration

An integration is done only when:

- tenant connection can be created by authorized Client Admin/System Admin
- scope can be ONE/SELECTED/ALL branches
- connection can be tested
- OAuth/credential lifecycle is implemented
- incoming data is normalized
- outgoing calls stay server-side
- webhook verification exists where applicable
- idempotency exists
- retry/error logging exists
- secrets are masked
- branch mappings work
- disconnect/reconnect works safely
- provider health is visible
- API tests cover failure cases

---

## 49. Explicit anti-patterns — do not do these

- Do not create a Team Leader role.
- Do not use phone number as `customer_id`.
- Do not auto-merge customers by phone.
- Do not change lifecycle `New` to `Pending` after one day.
- Do not make branch badges part of role names.
- Do not allow `ALL_BRANCHES` plus selected branches simultaneously.
- Do not trust UI hiding as authorization.
- Do not fetch all rows and paginate/filter in browser.
- Do not use `SELECT *` for list pages.
- Do not use global fuzzy search when page-local search is sufficient.
- Do not add Recharts/Chart.js/ApexCharts.
- Do not add another web component library.
- Do not proxy large recordings/documents through Next.js.
- Do not run unbounded long tasks inside Edge Function requests.
- Do not expose provider credentials.
- Do not store provider temporary recording URLs as permanent CRM media.
- Do not auto-apply AI field changes.
- Do not continuously store every test-drive GPS ping in Postgres.
- Do not let ordinary personal WhatsApp pretend to be CRM-synced history.
- Do not hard-delete tenant/business data from normal UI.
- Do not implement invisible Super Admin impersonation.
- Do not build full manager/operations mobile apps in MVP.
- Do not add UI automated-test frameworks unless product owner later asks for them.

---

## 50. Recommended implementation order

1. Supabase schema/migrations + tenancy/RLS helpers
2. Auth + MFA + tenant status gates
3. shared shadcn layout/component system + role navigation presets
4. Customer 360 core + canonical lead/customer model
5. Telecaller web/mobile
6. Sales Consultant web/mobile + test-drive GPS
7. Team Manager
8. Showroom Manager
9. GM Sales
10. Client Admin
11. Integrations/provider adapter infrastructure
12. Operational modules
13. System Administrator
14. Business Owner onboarding/executive
15. Super Admin platform
16. support access / retention / platform reports
17. performance hardening, API test expansion and final manual UI QA

---

## 51. Final architecture summary

```text
WEB: Next.js + TypeScript + Tailwind + shadcn/ui
CHARTS: Apache ECharts only
TABLES: TanStack Table + shadcn Table
SERVER STATE: TanStack Query
UI STATE: Zustand
WEB CACHE: IndexedDB (selected non-sensitive)

MOBILE: React Native + Expo + Expo Router
MOBILE CACHE: AsyncStorage
GPS BUFFER: SQLite

DB/AUTH/RLS: Supabase PostgreSQL + Auth + RLS
API/PROVIDER INGRESS: Supabase Edge Functions
REALTIME: Supabase Realtime
BACKGROUND: Trigger.dev
OBJECT STORAGE: Tigris Data (private S3-compatible)
TRANSACTIONAL EMAIL: Brevo

AUTH: Email + Password
PRIVILEGED MFA: TOTP

SECURITY MODEL:
USER -> ROLE -> PERMISSIONS -> DATA SCOPE

CUSTOMER MODEL:
Customer UUID -> many Leads -> many Bookings/Purchases -> many Vehicles

SALES HIERARCHY:
GM -> Showroom Manager -> Team Manager -> Sales Consultant + Telecaller/BDC

OPERATIONAL FLOW:
Booking -> Vehicle Allocation -> Finance if required -> Insurance -> RTO
-> PDI/Documents -> Ready for Delivery -> Delivered -> Customer Relationship
```

This file is intentionally opinionated. If an agent thinks a different library, role hierarchy, auth method, charting system, storage backend or provider workflow would be “better,” it must **not silently change the architecture**. Raise the proposed change for explicit approval first.

## 52. In-depth page-level production PRD

This section closes the gap between a navigation list and an implementable production page. **A page is not complete because its route/sidebar item exists.** Every page below must be implemented with the page-specific KPI, analytics, filters, table/list fields, actions and access rules defined in the role/dept appendices, plus the shared runtime contract in this section.

### 52.1 Required page specification contract

For every route/page, the implementing agent must resolve and implement all of the following before calling the page complete:

1. **Purpose** — the single job the page helps the role accomplish.
2. **Access** — required module, permission(s), tenant, branch/team/own-record scope and whether the page is read-only or mutable.
3. **Header** — title, short context/subtitle only when useful, role-appropriate primary action, date/branch/team filters when relevant.
4. **KPI cards** — only the metrics explicitly useful on that page. KPI cards are clickable when they naturally map to a filtered list.
5. **Analytics** — Apache ECharts only; use the exact chart families defined by the page PRD. Do not add decorative charts.
6. **Attention/priority area** — when defined, show actionable exceptions before low-priority history.
7. **Search/filter/sort** — page-local only. Search must query only fields relevant to that page.
8. **Main table/list/workspace** — exact domain columns, status badges and row actions from the page PRD. Never replace a specified table with generic cards on desktop.
9. **Detail drill-down** — row click/action opens the specified contextual page, Sheet, Dialog or dedicated detail route. Do not create duplicate disconnected detail experiences.
10. **Mutation safety** — Zod validation, permission check server-side, concurrency/transition validation where relevant, confirmation for destructive/high-impact actions, audit for privileged/business transitions.
11. **Loading/empty/error states** — Skeleton for first load, preserved table shell during refetch, clear empty-state CTA where applicable, retryable error state, and no fake success states.
12. **Query behavior** — use page-specific query keys, relevant invalidation only, no whole-app refresh after a mutation.
13. **Responsive behavior** — desktop/tablet follows screenshot density; mobile only exists for the explicitly approved Telecaller/Sales Consultant workflows.
14. **Manual UI QA** — compare to the corresponding approved screenshot/reference and verify the page acceptance flow.

If a role appendix omits one of these implementation mechanics, the shared rules below apply automatically.

### 52.2 Production table/list runtime contract

All normal desktop work queues, reports and admin lists use a single reusable `DataTableShell` composed from **shadcn Table + TanStack Table**.

Mandatory defaults:

- server-side filtering, sorting and pagination
- default page size `25`
- allowed page sizes `25 | 50 | 100`
- stable deterministic ordering; include an immutable tie-breaker such as `id` after the business sort key
- URL/search-param persistence for meaningful filters when the page benefits from shareable/back-button state
- page-local text search only
- `300ms` search debounce
- cancel/ignore stale requests when a newer search/filter request starts
- reset pagination to page 1 when a material filter/search changes
- do not fetch all rows and paginate/filter in the browser
- do not issue a separate SQL query per row; use joins/views/RPC/aggregates to avoid N+1
- select only list fields needed by the page; no `SELECT *` on production list queries
- server-enforced tenant + permission + scope on every query
- show total-count only when useful; use an efficient exact/estimated count strategy rather than repeatedly counting huge datasets unnecessarily
- retain previous page data during page changes when it improves perceived performance
- row selection is enabled only for a defined bulk action; do not add selection checkboxes by default
- export is an explicit permission and background job for large result sets

Reusable table pieces:

```text
DataTableShell
├─ PageSearchInput
├─ FilterBar
├─ AppliedFilterChips
├─ ColumnVisibilityMenu (only where useful)
├─ DataTable
├─ RowActionMenu
├─ EmptyState
└─ PaginationBar
```

### 52.3 Search and database index contract

Use normalized search columns where appropriate (`normalized_phone`, normalized email, normalized registration/VIN as relevant). Prefer B-tree indexes for equality/range/filter/order columns. Use `pg_trgm + GIN` only where users actually need fuzzy text search, especially customer/user/branch names. Never create trigram indexes on every text column.

For multi-tenant list pages, indexes should generally start with the highest-selectivity access dimensions used by the query, e.g. tenant + branch/team/owner/status/date as appropriate. Validate important query plans with `EXPLAIN (ANALYZE, BUFFERS)` against realistic data volumes before release.

### 52.4 Virtualization contract

**Pagination is the default. Virtualization is not the default.** Use TanStack Virtual only when the rendered DOM itself becomes large/high-density, for example:

- 100-row dense tables with many cells when profiling shows DOM cost
- long activity timelines/transcripts
- large permission matrices
- integration/audit/error logs
- large user/branch selectors
- long conversation histories

Do not virtualize a normal 25-row paginated table. Do not combine virtualization with server pagination unless it materially improves a measured UI bottleneck.

### 52.5 Dashboard query contract

Dashboards must not download raw records and count/group them in React. Use SQL views/materialized views where justified, RPC/functions or aggregate queries that return only the KPI/chart series required for the current tenant/scope/date range.

Dashboard implementation:

```text
Page shell
├─ KpiGrid
├─ AttentionList / RequiresAttention
├─ AnalyticsCard (ECharts)
├─ Secondary AnalyticsCard only when useful
└─ Focused summary table
```

Use one request/RPC per cohesive aggregate group rather than one network request per KPI card. Cache aggregate queries with TanStack Query; invalidate only the affected aggregate families after mutations.

### 52.6 Detail/workspace contract

Use reusable detail shells instead of re-creating page chrome:

```text
RecordWorkspace
├─ RecordHeader
├─ StatusBadge / WorkflowProgress
├─ SummaryCards
├─ Tabs
├─ DocumentPanel
├─ NotesPanel
├─ ActivityTimeline
└─ PrimaryActionBar
```

Operational cases use a common `CaseWorkspace` preset. Customer-related drill-down must reuse Customer 360 rather than creating duplicate customer pages.

### 52.7 Reusable preset families

Do not copy entire screens between roles. Reuse one domain component with role/page presets:

- `LeadWorklist`: Telecaller, Sales Consultant, Team Manager, Showroom Manager, GM read-only presets
- `FollowupWorklist`: personal, team, showroom presets
- `CallMonitor`: personal, team, showroom presets
- `AppointmentWorklist`: personal/team/showroom presets
- `TestDriveWorklist`: consultant/team/showroom presets
- `QuotationWorklist`: consultant/team/showroom/approval presets
- `BookingPipeline`: consultant/team/showroom/GM/owner presets
- `PerformanceDashboard`: personal/team/showroom/GM/owner presets
- `CaseWorkspace`: Finance/Insurance/RTO/Exchange/Delivery/Customer Care presets
- `AdminUserWorkspace`: Client Admin/System Admin/Business Owner/Super Admin presets
- `IntegrationWorkspace`: tenant connection/system-admin/support presets
- `ReportWorkspace`: role-scoped metric/report presets

A preset may change visible columns, default filters, permissions/actions, scope/query and KPI/chart configuration. It must not fork the underlying component without a materially different interaction model.

### 52.8 Common shadcn-only page composition

The web UI must use only approved shadcn primitives/compositions. Typical mapping:

- KPI: `Card`
- status: `Badge`
- filters: `Select`, `Command`, `Popover`, `Calendar`, `Input`
- forms: `Form`, `Input`, `Textarea`, `Checkbox`, `RadioGroup`, `Switch`
- row actions: `DropdownMenu`
- quick detail/edit: `Sheet`
- focused create/edit flow: route or `Dialog` depending complexity
- destructive confirmation: `AlertDialog`
- sectioning: `Tabs`, `Accordion`, `Separator`
- loading: `Skeleton`
- long bounded content: `ScrollArea`

No second design system or third-party dashboard component kit.

### 52.9 ECharts contract

Use Apache ECharts only. Each chart must answer a business question and expose accessible text/summary values nearby when needed. Prefer:

- Funnel — stage conversion
- Line — trend over time
- Bar — branch/team/user/model/source comparisons, target vs actual
- Donut — compact status/source/usage composition

Lazy-load heavy chart code where beneficial. Chart queries return pre-aggregated series. Do not transform tens of thousands of raw rows in the browser to construct a chart.

### 52.10 Per-page API test expectation

UI is manually tested, but each new backend behavior exposed by a page requires API/backend tests for at least: authorized success, unauthenticated/unauthorized denial, tenant isolation, scope denial, invalid payload, important transition conflict/idempotency case, and provider/webhook failure where relevant. No automated UI suite is required for MVP.

### 52.11 Provider/API execution boundary

Browser/mobile -> Supabase authenticated API/Edge Function. Secret-bearing provider calls and webhooks are handled server-side. If the operation can exceed normal request time or needs durable retry/scheduling, the Edge Function validates/orchestrates and enqueues Trigger.dev. Large files use direct presigned Tigris transfers rather than proxying bytes through the web app.

---

## 53. Approved UI screenshot reference index

The screenshots supplied during discovery are **visual references**, not permission/workflow authority. Match their spacing, hierarchy, density, card/table patterns and interaction style using shadcn only. The final PRD rules override old screenshot content (for example, deprecated Team Leader references).

Reference groups:

- `01–08`: Telecaller / BDC
- `09–24`: Sales Consultant, Customer 360, conversations, test drives, quotations, stock, exchange, booking, performance
- `25–32`: Team Manager
- `33–36`: Showroom Manager
- `37–41`: GM Sales Executive
- `42–46`: Inventory
- `47–49`: Insurance
- `51–52`: RTO
- `57–59`: Delivery
- `61–64`: Business Owner
- `65–79`: dealership administration / users / roles / branches / master data / integrations / automation / templates / alerts / audit / backup / security
- `80–84`: Super Admin platform / dealerships / plans / AI usage

When both a base screenshot and `(1)`/`(2)` variant exist, use the latest product decision for behavior and the clearest supplied variant for visual styling.

---

## 54. Authoritative role and department page specifications

The following normalized PRDs are embedded so an implementing agent can determine **what every page does**, not just which sidebar item exists. Shared rules in Sections 0–53 override any older technology wording preserved in a role PRD. In particular: private files/recordings/documents use **Tigris Data**, not Supabase Storage; web components remain **shadcn only**; charts remain **Apache ECharts only**; secret-bearing provider calls remain behind **Supabase Edge Functions/provider adapters**; long-running work uses **Trigger.dev**.

### 54.1 Telecaller / BDC — detailed page PRD

##### Telecaller / BDC — Final PRD

---

##### 1. Core Data Concept

###### Lead

A Lead is one enquiry.

Example:

> Ravi enquires for Honda City from Facebook.

Six months later:

> Ravi enquires for Elevate from CarWale.

These are **two Leads**, but potentially the **same Customer**.

###### Customer

Customer is the long-term **source of truth**.

CUSTOMER

   │

   ├── Personal Information

   ├── Contact Information

   ├── Custom Information

   ├── Vehicle History

   ├── Communication Timeline

   │

   ├── Lead 1

   │    └── Purchase 1

   │

   └── Lead 2

        └── Purchase 2




---

#### 2. Customer Unique ID

Do **not** make phone number the unique customer ID.

Use:

customer\_id = UUID



Example:

a63c5607-ff04-4d58-9ae8-51dc23c6f100



Phone becomes a **matching/search field**.

This allows:

- same customer to change phone
- customer to have two phone numbers
- husband/wife to share one number
- same number to legitimately appear under two customers
- one customer to buy multiple vehicles

---

#### 3. Duplicate Customer Handling

When a lead arrives with:

Phone: 9876543210



backend searches existing customers.

If found:

Possible Existing Customer



Ravi Kumar

Phone: 9876543210

Previous Vehicle: Honda City

Customer Since: 2024



Telecaller gets:

**Link Existing Customer**

**Create New Customer**

Never automatically merge just because phone matches.

If Ravi buys two vehicles:

Ravi Kumar

Customer UUID: ABC-123



├── Honda City — 2024

└── Honda Elevate — 2026



One Customer. Two purchases.

---

#### 4. Lead Sources

Canonical source values:

Facebook

Instagram

Google Ads

Website

WhatsApp Business

CarWale

CarDekho

Justdial

IndiaMART

Manual

Other



Known provider → use actual provider name.

So:

{

  "source": "CarWale"

}



not:

{

  "source": "Other",

  "source\_detail": "CarWale"

}



`Other` is only for a source that has not yet been configured.

---

#### 5. Incoming Lead Minimum Fields

For the normal Telecaller workflow, require:

| **CRM field**    | **Required**     |
| ---------------- | ---------------- |
| Source           | Yes              |
| Customer Name    | Yes              |
| Phone            | Yes              |
| Email            | Optional         |
| Location         | Optional         |
| Campaign         | Optional         |
| Interested Model | Optional         |
| Preferred Branch | Optional         |
| Source Detail    | Optional         |
| External Lead ID | Source dependent |

Branch can also be inferred from the connected integration.

---

#### 6. Source Field Mapping

Different providers can send different names.

###### Meta

full\_name

phone\_number

campaign\_name

vehicle\_model

email

city




###### Website

customer\_name

mobile

preferred\_vehicle

branch

email\_address

location



CRM maps both into:

Customer Name

Phone

Campaign

Interested Model

Email

Location

Branch



Flow:

EXTERNAL SOURCE

      ↓

FIELD MAPPING

      ↓

VALIDATION

      ↓

NORMALIZATION

      ↓

CANONICAL LEAD

      ↓

BRANCH / TEAM ASSIGNMENT

      ↓

TELECALLER NEW LEADS



The original provider payload remains stored server-side for traceability.

---

#### 7. Who Configures Lead Sources?

###### Primary

**Client Admin**

###### Can also be authorised

- System Administrator
- Digital Marketing Manager

Telecaller cannot configure integrations.

---

#### 8. Branch Integration Configuration

Every connected source/account supports:

One Branch

Selected Branches

All Branches



Example:

###### Client A

Branch 1 has its own Meta and IVR account.

Branch 2 has another Meta and IVR account.

###### Client B

All branches use one shared Meta account and one IVR system.

Both configurations must work.

---

#### 9. Website / External Leads

No script tag.

Provide secure endpoint.

Example:

POST /api/v1/leads/ingest/{connection-id}



External website/backend sends:

{

  "source": "Website",

  "customer\_name": "Ravi Kumar",

  "phone": "9876543210",

  "email": "ravi\@gmail.com",

  "location": "Bengaluru",

  "interested\_model": "Honda Elevate",

  "campaign": "August Website Campaign"

}



Client Admin integration screen shows:

- Endpoint URL
- Authentication
- Payload example
- Field Mapping
- Test Connection
- Test Lead
- Last Success
- Last Error
- Enable / Disable

---

#### 10. Lead Lifecycle

Actual lifecycle:

New

Contacted

Qualified

Appointment Scheduled

Transferred to Sales

Lost



Follow-up should primarily be an **activity/state attached to a lead**, because even a Qualified lead can still have a follow-up.

---

#### 11. Lead Age / Work State

Separate from lifecycle.

###### Less than 24 hours and not contacted

**New Today**

###### More than 24 hours and not contacted

**Pending**

###### Exceeds configured SLA

**SLA Risk**

Example:

Lifecycle: New

Work State: Pending

Lead Age: 1d 4h



This is much cleaner than changing the lifecycle automatically.

---

#### 12. Qualification

When connected, Telecaller captures:

Interested Model

Variant

Budget

Purchase Timeline

Finance Required

Exchange Required

Test Drive Required

Preferred Branch

Preferred Contact Time

Temperature

Customer Notes




###### Temperature

Hot

Warm

Cold



If there is genuine interest and sufficient information:

**Qualified**

---

#### 13. Follow-up Rule

A lead can be:

Contacted + Follow-up scheduled



or:

Qualified + Follow-up scheduled



So follow-up does not need to become the main customer lifecycle.

Example:

Status: Qualified

Next Follow-up: Tomorrow 11:00 AM




---

#### 14. Sales Consultant Transfer

Once qualified:

**Qualify & Transfer**

Telecaller selects:

Sales Consultant

Branch

Transfer Note



If Telecaller schedules a:

**Showroom Visit**

or:

**Test Drive**

the selected Sales Consultant is attached to that appointment and can become the assigned sales owner.

Then:

Telecaller

   ↓

Qualified Lead

   ↓

Sales Consultant




---

#### 15. Telecaller Communication Actions

Final quick communication actions:

###### Call

Always available when customer has phone.

###### WhatsApp

Available when dealership WhatsApp connection is enabled.

###### Facebook Messenger

Available when lead/customer has a connected Facebook conversation.

###### Instagram DM

Available when connected Instagram messaging is available for that account/customer thread.

Do not show inactive channel buttons unnecessarily.

---

#### 16. Chat History

Connected conversations must be stored in one timeline.

Example:

10:15 AM — Facebook Messenger

Customer: Is Elevate available?



10:18 AM — Telecaller

Yes sir, which variant are you interested in?



11:04 AM — Phone Call

Duration: 4m 12s



11:20 AM — WhatsApp

Showroom location sent



Customer/Lead Detail therefore has a single chronological **Activity Timeline**.

---

#### 17. SMS / Email

For current Telecaller MVP:

**Do not show SMS and Email as primary Telecaller communication buttons.**

They can remain available elsewhere for:

- system notifications
- automated reminders
- campaigns
- transactional communication

This keeps Telecaller simple.

---

#### 18. Calling — Provider / IVR Enabled Branch

Each branch can have its own calling integration.

When enabled:

**Call**

↓

CRM creates call reference

↓

opens/directs user into configured IVR/calling provider flow

↓

Telecaller completes call

↓

returns to CRM

↓

**Sync Call**

Sync fetches available provider information:

Call Status

Date

Time

Duration

Disposition

Recording

Transcript

Provider Call ID



Store it against the Lead and Customer timeline.

---

#### 19. Personal Number Calls

If Telecaller uses personal/mobile number outside integrated IVR:

Allow:

**Upload Call Recording**

On Web:

shadcn file/input interaction.

On Mobile:

Expo document/file picker.

Accepted conceptually:

MP3

M4A

WAV



Telecaller selects:

- Related Customer/Lead
- Call Date/Time
- Call Outcome
- Recording File
- Optional Notes

Then:

**Upload**

Recording goes into private Tigris Data object storage.

Do **not** assume React Native can automatically record every normal cellular call.

---

#### 20. AI Processing

After recording/transcript is available:

Recording

   ↓

Transcript

   ↓

AI Processing

   ↓

Call Summary

   ↓

Detected Information



AI can suggest:

Interested Model

Variant

Budget

Purchase Timeline

Finance Requirement

Exchange Requirement

Test Drive Requirement

Follow-up Date

Customer Notes



Then:

**Review Suggestions**

↓

Select fields

↓

Edit if required

↓

**Apply Selected Changes**

AI never automatically overwrites CRM data.

---

#### 21. AI Credits

Keep AI credit-based.

###### Super Admin

Allocates AI credits to each dealership/business account.

Example:

Dealership A

Allocated: 100,000 credits



Used: 34,200



Remaining: 65,800




###### Client Admin

Can see:

- Allocated credits
- Used
- Remaining
- Feature usage

###### Users

Telecaller/Sales users consume credits from the dealership's AI wallet when using eligible AI features.

Examples:

- Transcription
- AI Summary
- Field Extraction

This makes future billing manageable.

---

#### 22. Low-Level Customer Database Access

Do **not** let Telecaller browse the entire company customer database.

###### Telecaller

Can see:

- New leads assigned/available to them
- Own assigned leads
- Customers linked to those leads
- Customer history relevant to those linked customers

###### Sales Consultant

Can see:

- Leads assigned/transferred to them
- Customers linked to those leads
- Customer 360 for assigned customers

###### Team Leader / Team Manager

Team scope.

###### Showroom Manager

Branch scope.

###### GM

Configured branch scope.

###### Business Owner / Client Admin

Organization-level scope according to permissions.

---

#### 23. TELECALLER WEB

Final sidebar:

Dashboard

New Leads

My Leads

Follow-ups

Tasks

Calls

Appointments

Performance



Contextual:

**Lead / Customer Detail**

---

#### 24. Dashboard

###### KPI Cards

New Leads Today

Not Contacted

Follow-ups Due

Calls Today

Qualified Today

Appointments Today



Use:

**shadcn Card**

###### Today's Priority

New Leads Not Contacted

Pending Leads

Overdue Follow-ups

Callbacks Due



Row:

Customer

Model

Source

Lead Age

Priority

Call

Open




###### Calls Activity

**Apache ECharts Line**

- Total Calls
- Connected Calls

###### Lead Lifecycle

**Apache ECharts Donut**

- New
- Contacted
- Qualified
- Appointment Scheduled
- Transferred
- Lost

###### Recent Leads Table

Customer

Phone

Source

Model

Temperature

Lifecycle

Work State

Next Follow-up

Action




---

#### 25. New Leads

###### KPI

New Today

Pending

Not Contacted

SLA Risk




###### Filters

Search

Source

Campaign

Interested Model

Preferred Branch

Created Date

Work State




###### Table

Lead ID

Created At

Customer

Phone

Source

Campaign

Model

Branch

Lead Age

Work State

Contact Status

Action



Example:

LD-1922

Today 10:14

Ravi Kumar

9876543210

CarWale

Honda City Lead

City

MG Road

1h 12m

New Today

Not Contacted

Call



Actions:

Call

WhatsApp

Messenger

Instagram

Open



Only display connected channels.

---

#### 26. My Leads

###### KPI

Active Leads

Hot

Warm

Cold

Follow-ups Due




###### Tabs

All

Hot

Warm

Cold

Follow-up Due




###### Table

Customer

Phone

Source

Interested Model

Temperature

Lifecycle

Work State

Last Contact

Next Follow-up

Action




---

#### 27. Follow-ups

###### KPI

Overdue

Due Today

Upcoming

Completed Today




###### Tabs

Overdue

Today

Upcoming

Completed




###### Columns

Time

Customer

Phone

Model

Reason

Previous Note

Priority

Lead Status

Follow-up Status

Action



Actions:

Call

WhatsApp

Complete

Reschedule




---

#### 28. Tasks

###### KPI

Overdue

Due Today

Upcoming

Completed




###### Tabs

My Tasks

Assigned to Me

Created by Me

Follow-up Tasks




###### Columns

Task

Customer

Type

Priority

Due Date

Due Time

Created By

Status

Action




---

#### 29. Calls

###### KPI

Total Calls

Connected

Connection Rate

Average Duration

No Answer

Callbacks Required




###### Apache ECharts Line

Total Calls

Connected Calls




###### Apache ECharts Donut

Connected

No Answer

Busy

Switched Off

Callback

Wrong Number




###### Table

Customer

Phone

Call Source

Call Type

Date & Time

Duration

Outcome

Recording

Transcript

AI Summary

Sync Status

Action




###### Call Source

IVR / Provider

Personal Call Upload




###### Actions

Depending on record:

Sync Call

Upload Recording

Open




---

#### 30. Appointments

Types:

Showroom Visit

Test Drive




###### Columns

Customer

Phone

Type

Date

Time

Model

Branch

Sales Consultant

Status

Action



When scheduling:

Customer

Appointment Type

Date

Time

Branch

Interested Model

Sales Consultant

Notes




---

#### 31. Performance

Personal only.

###### KPI

Leads Contacted

Calls Made

Connected Calls

Connection Rate

Qualified Leads

Follow-ups Completed

Appointments Booked

Leads Transferred




###### Apache ECharts Line

Calls Made vs Connected.

###### Apache ECharts Funnel

New

Contacted

Qualified

Appointment

Transferred




###### Apache ECharts Bar

Follow-ups On Time

Late

Missed




---

#### 32. Lead / Customer Detail

This becomes the main **Customer 360 working screen**.

###### Header

Customer Name

Phone

Lead ID

Source

Lifecycle

Temperature

Work State



Actions:

Call

WhatsApp

Messenger

Instagram



only if available.

###### Customer Information

Name

Primary Phone

Alternate Phone

Email

DOB

Anniversary

Occupation

Company

Address

City

PIN




###### Lead Information

Source

Source Detail

Campaign

External Lead ID

Created At

Preferred Branch

Current Telecaller




###### Interested Vehicle

Brand

Model

Variant

Colour




###### Requirements

Budget

Purchase Timeline

Finance Required

Exchange Required

Test Drive Required

Preferred Contact Time




###### Existing / Previous Vehicles

Brand

Model

Variant

Registration

Year

Fuel

Ownership

Approx KM

Current Vehicle



Multiple vehicles supported.

###### Custom Information

Tenant-configured fields.

Example:

Preferred Language

Corporate Employee ID

Referral Code

Customer Category




###### Previous Leads / Purchases

Example:

2024

Website

Honda City

Delivered



2026

CarWale

Honda Elevate

Current Lead




###### Call Section

Previous Call Summary

Recording

Transcript

AI Summary

Pending Action

Sync Call

Upload Recording




###### Follow-up

Date

Time

Reason

Priority

Reminder




###### Appointment

Type

Date

Time

Branch

Sales Consultant

Status




###### Notes

Full notes history.

###### Activity Timeline

Lead Created

Customer Linked

Call

Recording Uploaded

Call Synced

WhatsApp

Facebook Messenger

Instagram DM

Note

Follow-up

Appointment

Status Change

Temperature Change

Assignment

Transfer

Purchase History




---

#### 33. Mobile

Keep mobile intentionally simple.

Bottom navigation:

Home

My Leads

Follow-ups

Tasks



Contextual:

**Lead Detail**

Use React Native + Expo + Expo Router.

Use normal React Native components:

SafeAreaView

View

Text

Pressable

TextInput

FlatList

SectionList

ScrollView

Modal

RefreshControl

ActivityIndicator



No Apache ECharts needed in Telecaller mobile MVP.

---

#### 34. Mobile Home

Show:

Priority Leads

Pending Leads

Follow-ups Today

Callbacks

Tasks Today



Customer card:

Customer

Model

Source

Status

Due Time



Actions:

**Call | WhatsApp**

---

#### 35. Mobile My Leads

Tabs:

All

Hot

Warm

Cold



Card:

Customer

Model

Source

Temperature

Lifecycle

Next Follow-up

Lead Age




---

#### 36. Mobile Follow-ups

Overdue

Today

Upcoming



Card:

Customer

Model

Reason

Time

Priority



Actions:

Call

Complete

Reschedule




---

#### 37. Mobile Tasks

Overdue

Today

Upcoming



Card:

Task

Customer

Priority

Due Time




---

#### 38. Mobile Lead Detail

Show:

Customer Details

Lead Source

Interested Vehicle

Requirements

Previous Vehicles

Custom Information

Previous Leads/Purchases

Previous Call Summary

Follow-up

Appointment

Notes

Recent Activity



Actions:

Call

WhatsApp

Upload Recording

Sync Call

Update Status

Update Temperature

Add Follow-up

Schedule Appointment

Qualify & Transfer




---

#### 39. Technical UI Rule

###### Web

**shadcn/ui**

No separate custom component library.

###### Charts

**Apache ECharts only**

###### Tables

**TanStack Table + shadcn Table**

###### Server Data

**TanStack Query**

###### Lightweight Local State

**Zustand**

###### Web Persistence

**IndexedDB**

###### Mobile Persistence

**AsyncStorage**

###### Backend

Supabase + RLS.

---

#### 40. Refresh / Cache Rule

TanStack Query:

staleTime = 60 sec

gcTime = 30 min

refetchOnWindowFocus = false

refetchOnReconnect = true



Manual Refresh:

**Maximum 3 times/minute/user/page-resource**

Only relevant query keys are refetched.

---

#### Final Telecaller Flow

FACEBOOK

INSTAGRAM

GOOGLE ADS

WEBSITE

WHATSAPP BUSINESS

CARWALE

CARDEKHO

JUSTDIAL

INDIAMART

OTHER PROVIDERS

MANUAL

        ↓

SOURCE FIELD MAPPING

        ↓

CANONICAL LEAD

        ↓

BRANCH / TEAM ASSIGNMENT

        ↓

TELECALLER NEW LEADS

        ↓

NEW TODAY / PENDING / SLA RISK

        ↓

CONTACT

        ↓

CUSTOMER MATCH

     ↙       ↘

 EXISTING     NEW

     ↘       ↙

    CUSTOMER 360

        ↓

QUALIFICATION

        ↓

CONTACTED / QUALIFIED

        ↓

FOLLOW-UP

        ↓

SHOWROOM / TEST DRIVE

        ↓

SALES CONSULTANT ASSIGNMENT

        ↓

TRANSFER TO SALES



And the most important database principle is:

**Customer = source of truth.**
**Lead = individual enquiry.**
**Phone = matching identifier, not Customer ID.**
**One Customer can have many leads, many vehicles and many purchases.**

This version covers the source mapping, branch-specific integrations, IVR/personal calls, recording upload, call sync, AI credits, chats, customer matching, Customer 360, repeat purchases, low-level access, Web and Mobile Telecaller screens, shadcn, ECharts and caching rules together.

Yes pa — the **Telecaller PRD also needs this correction**. The rest of the Telecaller PRD stays the same; update these two parts.

###### 1. Telecaller Performance

**Telecaller Performance page = personal performance only.**

Telecaller sees:

- Leads Contacted
- Calls Made
- Connected Calls
- Connection Rate
- Qualified Leads
- Follow-ups Completed
- Appointments Booked
- Leads Transferred to Sales
- Personal targets

Hierarchy visibility:

**Telecaller → Own performance**
**Team Manager → All Telecallers + Sales Consultants in own team**
**Showroom Manager → All teams/users in own branch**
**GM → Configured branch/multi-branch performance**

Telecaller does **not** see team ranking or other employees' performance.

---

###### 2. Qualified Lead → Sales Consultant Assignment

Replace the old simple transfer rule with:

Telecaller Qualifies Lead

        ↓

Check Team Assignment Mode

        ↓

 ┌─────────────────────┐

 │                     │

Round Robin        Manual Assignment

 │                     │

CRM selects         Telecaller selects

next eligible       eligible Sales

Sales Consultant    Consultant

 │                     │

 └──────────┬──────────┘

            ↓

Sales Consultant Assigned

            ↓

Appointment / Sales Follow-up



**Team Manager configures the assignment mode for their team.**

#### Round Robin

CRM automatically assigns the next eligible Sales Consultant based on:

- Team
- Branch
- Active/available status
- Assignment eligibility

#### Manual Assignment

Telecaller gets a dropdown containing **only eligible Sales Consultants from their permitted team/branch**.

They select the consultant and press:

**Qualify & Transfer**

#### Reassignment

- **Team Manager** → can reassign within own team.
- **Showroom Manager** → can override/reassign within their branch.

Every change stores:

```
Previous Consultant | New Consultant | Assigned By | Assignment Method | Date/Time | Reason
```

And if a user has **Sales Consultant + Telecaller capability**, after qualifying their own fresh lead they can simply **continue as the Sales Consultant** instead of transferring it to themselves.

So yes pa — this rule belongs in **both Telecaller PRD and Sales Consultant PRD**.


### 54.2 Sales Consultant — detailed page PRD

##### Sales Consultant — Final Frozen PRD

###### 1. Role purpose

The Sales Consultant owns the customer after qualification and handles the sales journey through booking.

**Normal flow:**

**Qualified Lead → Sales Consultant Assigned → Follow-up / Showroom Visit → Test Drive → Quotation → Stock Check → Exchange if required → Booking**

The Sales Consultant can also be given **Telecaller capability**. In that case, the same user can work fresh leads, qualify them and continue as the Sales Consultant without transferring the lead to themselves.

---

#### 2. Sales Consultant Web Sidebar

###### Standard Sales Consultant

1. Dashboard
2. My Leads
3. Follow-ups
4. Tasks
5. Calls
6. Appointments
7. Test Drives
8. Quotations
9. Stock Check
10. Exchange
11. Bookings
12. Performance

###### Sales Consultant + Telecaller capability

Add:

**New Leads**

So:

**Dashboard → New Leads → My Leads → Follow-ups → Tasks → Calls → Appointments → Test Drives → Quotations → Stock Check → Exchange → Bookings → Performance**

###### Contextual pages, not sidebar

- Customer 360
- Conversation / WhatsApp
- Competitor Comparison
- Create Quotation
- Create Test Drive
- Active Test Drive
- Test Drive Feedback
- Booking Detail

---

#### 3. Sales Consultant Mobile

Bottom navigation:

1. Home
2. My Leads
3. Follow-ups
4. Appointments
5. Test Drives
6. Tasks

Contextual:

**Customer Detail**

No large analytics pages on mobile.

---

#### 4. Assignment rule — FINAL

This is now fixed.

When Telecaller qualifies a lead, the **Team Manager configures how Sales Consultant assignment works for that team.**

Two modes:

###### Round Robin

CRM automatically chooses the next eligible Sales Consultant.

Flow:

**Qualified → Round Robin → Sales Consultant Assigned**

###### Manual Assignment

Telecaller qualifies the lead and sees only eligible Sales Consultants from the permitted team/branch.

Flow:

**Qualified → Telecaller selects Sales Consultant → Transfer**

The Telecaller cannot select any user in the entire dealership.

###### Reassignment

**Team Manager**

- can reassign within their team

**Showroom Manager**

- can override/reassign within the branch

Every assignment change stores:

- Previous owner
- New owner
- Assigned by
- Assignment method
- Date/time
- Reason
- Branch/team

---

#### 5. Sales Consultant + Telecaller mode

Client Admin/authorized manager can give the user both capabilities.

Example:

**Rahul**

- Sales Consultant role
- Telecaller permission bundle

Then Rahul can:

**New Lead → Contact → Qualify → Continue as Sales Owner**

No pointless transfer back to himself.

Role and permission remain independent.

---

#### 6. Performance visibility — FINAL

###### Telecaller

**Own performance only**

###### Sales Consultant

**Own performance only**

###### Team Manager

Can see:

- All Sales Consultants in own team
- All Telecallers in own team
- Team totals
- Individual comparison

###### Showroom Manager

Can see:

- All teams in their branch
- All Team Managers
- All Sales Consultants
- All Telecallers
- Branch totals

###### GM

Sees configured branch/all-branch sales performance.

###### Business Owner

High-level organization KPIs.

So the individual Sales Consultant Performance page is still personal.

Manager screens aggregate the same underlying performance data according to hierarchy.

---

#### 7. Data access

Sales Consultant sees:

- Assigned leads
- Assigned customers
- Customer 360 for those customers
- Own calls
- Own follow-ups
- Own tasks
- Own appointments
- Own test drives
- Own quotations
- Relevant stock information
- Own exchange requests
- Own bookings
- Own performance

Sales Consultant does **not** freely browse the entire dealership customer database.

---

#### 8. Web technology

###### UI

**shadcn/ui**

Use existing primitives:

- Sidebar
- Card
- Button
- Badge
- Table
- Tabs
- Input
- Select
- Command
- Popover
- Calendar
- Dialog
- Sheet
- DropdownMenu
- Tooltip
- Avatar
- Checkbox
- RadioGroup
- Textarea
- Progress
- Separator
- ScrollArea
- Skeleton

Do not build another custom component library.

###### Tables

**TanStack Table + shadcn Table**

###### Charts

**Apache ECharts only**

Use:

- Line
- Bar
- Donut
- Funnel

Do not use Recharts.

###### Server state

**TanStack Query**

###### Lightweight UI state

**Zustand**

###### Web persistent non-sensitive cache

**IndexedDB**

---

#### 9. Dashboard

Purpose:

**Tell the Sales Consultant what requires action today.**

###### KPI cards

- Leads Assigned Today
- Hot Leads
- Follow-ups Today
- Calls Pending
- Test Drives Today
- Quotations Pending
- Bookings This Month
- Target Achievement

###### Requires Attention

- Hot Lead Not Called
- Overdue Follow-up
- Test Drive Completed — Quotation Pending
- Quotation Sent — Customer Response Pending
- Customer Waiting for Stock

###### Sales Pipeline

**Apache ECharts Funnel**

**Assigned → Follow-up → Test Drive → Quotation → Booking**

###### Today’s Schedule

Show:

- Time
- Customer
- Activity
- Vehicle
- Status

Activities:

- Call
- Follow-up
- Showroom Visit
- Test Drive

###### Recent Leads

Columns:

- Customer
- Phone
- Model
- Source
- Sales Stage
- Temperature
- Next Follow-up
- Action

---

#### 10. My Leads

###### KPI

- Active Leads
- Hot
- Warm
- Cold
- Follow-ups Due
- Test Drives Pending
- Quotations Pending

###### Tabs

- All
- Hot
- Warm
- Cold
- Follow-up Due
- Test Drive
- Quotation
- Booking

###### Filters

- Search
- Model
- Source
- Sales Stage
- Temperature
- Follow-up Date

###### Table columns

- Customer
- Phone
- Interested Model
- Source
- Sales Stage
- Temperature
- Last Activity
- Next Follow-up
- Lead Age
- Action

Actions:

**Call | WhatsApp | Appointment | Open**

---

#### 11. Follow-ups

###### KPI

- Overdue
- Due Today
- Upcoming
- Completed Today

###### Reasons

- Customer Callback
- Test Drive Confirmation
- Quotation Discussion
- Price Negotiation
- Stock Update
- Exchange Update
- Booking Confirmation
- Document Reminder
- General Follow-up

###### Table

- Time
- Customer
- Model
- Reason
- Previous Note
- Sales Stage
- Priority
- Status
- Action

Actions:

**Call | WhatsApp | Complete | Reschedule | Open Customer**

---

#### 12. Tasks

Personal operational tasks.

###### Groups

- Overdue
- Today
- Upcoming
- Completed

###### Task types

- Customer Call
- Follow-up
- Test Drive Preparation
- Quotation Follow-up
- Stock Confirmation
- Exchange Follow-up
- Booking Action
- Document Collection
- Customer Update

###### Columns

- Task
- Customer
- Related Module
- Priority
- Due Date
- Due Time
- Created By
- Status
- Action

Sales Consultant does not get team task administration.

---

#### 13. Calls

Same shared call engine as Telecaller.

###### KPI

- Total Calls
- Connected
- Connection Rate
- Average Duration
- Callbacks Required
- Follow-ups Created

###### Apache ECharts Line

- Total Calls
- Connected Calls

###### Apache ECharts Donut

- Connected
- No Answer
- Busy
- Switched Off
- Callback
- Wrong Number

###### Table

- Customer
- Phone
- Call Source
- Date & Time
- Duration
- Outcome
- Recording
- Transcript
- AI Summary
- Follow-up
- Sync Status
- Action

---

#### 14. IVR/provider calls

If the branch has calling integration:

**Call → Provider call flow → Return CRM → Sync Call**

Sync can retrieve:

- Provider Call ID
- Call status
- Date/time
- Duration
- Recording
- Transcript
- Disposition

---

#### 15. Personal mobile call recording

If Sales Consultant calls from a personal number:

Allow:

**Upload Recording**

Files:

- MP3
- M4A
- WAV

Capture:

- Customer
- Lead
- Date
- Time
- Outcome
- Recording
- Notes

Do not assume the mobile app can automatically record every normal phone call.

---

#### 16. AI call intelligence

Flow:

**Recording/Transcript → AI → Summary → Suggested Fields → Human Review → CRM Update**

Possible detected fields:

- Model
- Variant
- Budget
- Purchase Timeline
- Finance Required
- Exchange Required
- Test Drive Required
- Competitor Mentioned
- Follow-up
- Customer Intent

AI never silently overwrites fields.

AI usage consumes the dealership’s allocated AI credits.

---

#### 17. Appointments

Types:

- Showroom Visit
- Test Drive

###### KPI

- Today
- Upcoming
- Confirmed
- Completed
- Rescheduled
- No Show

###### Table

- Customer
- Phone
- Type
- Date
- Time
- Model
- Branch
- Status
- Action

Actions:

**Confirm | Reschedule | Complete | Open Customer**

---

#### 18. Test Drives

###### Tabs

- Today
- Upcoming
- Active
- Completed
- Cancelled

###### KPI

- Today
- Active
- Completed This Month
- Conversion After Test Drive

###### Filters

- Customer
- Model
- Status
- Date

A normal Sales Consultant sees only their own test drives.

###### Table

- Customer
- Model
- Variant
- Test Drive Vehicle
- Registration
- Date
- Time
- Status
- GPS Status
- Feedback Status
- Action

---

#### 19. Create Test Drive

###### Customer

- Customer
- Phone

###### Vehicle

- Model
- Variant
- Test Drive Vehicle
- Registration

###### Schedule

- Date
- Time
- Expected Duration

###### Route

- Start Location
- Planned Destination / Customer Location

###### Vehicle start information

- Start KM

Actions:

**Save | Start Test Drive | Cancel**

---

#### 20. Test Drive GPS architecture

This is the optimized final design.

When the Sales Consultant starts:

**Start Test Drive**

send immediately:

- Test Drive ID
- Consultant
- Vehicle
- Start Time
- Start Latitude
- Start Longitude
- Start KM

---

#### 21. Local route tracking

During the drive, React Native/Expo records GPS points locally.

Use:

**Expo background location + local SQLite buffer**

Not Zustand for GPS route storage.

Default:

**Do not continuously send all GPS points to the CRM server.**

This saves:

- network
- server writes
- database storage
- battery
- infrastructure cost

---

#### 22. Route anchor points

Server permanently stores:

###### Start

- Latitude
- Longitude
- Timestamp
- Start KM

###### Destination/reached point

- Latitude
- Longitude
- Reached timestamp

###### Completion

- Latitude
- Longitude
- Completion timestamp
- End KM

Then calculate:

- Duration
- Distance
- KM difference
- Route summary

---

#### 23. Manager live tracking

Live GPS happens **on demand**.

Authorized users:

###### Team Manager

Can live-track active test drives in own team.

###### Showroom Manager

Can live-track active test drives in their branch.

They click:

**Live Track**

Backend creates a temporary tracking session.

Target duration:

**10 minutes**

Flow:

**Manager requests → Backend push/wake → Consultant app responds → Current location uploaded → Temporary live updates → Auto stop after 10 minutes**

This means your server is not receiving live location unnecessarily all day.

---

#### 24. If phone cannot respond

If:

- app killed
- GPS disabled
- background permission denied
- no internet
- device switched off

show:

**Live Location Unavailable**

and:

**Last Known Location — [time]**

Do not display stale location as live.

---

#### 25. Higher-level GPS visibility

###### Team Manager / Showroom Manager

Can request temporary live tracking according to scope.

###### GM / Client Admin / Business Owner

Default view:

- Start location
- Start time
- Destination/reached point
- End location
- Completion time
- Duration
- Distance
- Start KM
- End KM
- Completed route summary

They do not need permanent live tracking by default.

---

#### 26. Test Drive completion

At end:

Mobile captures:

- End location
- End timestamp
- End KM

The local route buffer is simplified/compressed.

Then upload:

**Route summary + required route points**

Do not upload thousands of raw GPS records when unnecessary.

---

#### 27. Test Drive Feedback

After completion:

###### Ratings 1–5

- Driving Experience
- Comfort
- Features
- Performance
- Price Perception
- Overall Rating

Also:

- Customer Comments
- Competitor Compared
- Purchase Intent

Purchase Intent:

- Highly Interested
- Interested
- Considering
- Not Interested

Actions:

**Create Quotation | Schedule Follow-up**

---

#### 28. Quotations

###### Tabs

- Draft
- Sent
- Revised
- Approval Pending
- Approved
- Expired

###### KPI

- Total Quotations
- Sent Today
- Approval Pending
- Expiring Soon

###### Table

- Quote ID
- Customer
- Model
- Variant
- Created Date
- On-Road Price
- Discount
- Status
- Last Sent
- Action

Actions:

**View | Edit | Revise | Send**

---

#### 29. Create Quotation

###### Vehicle

- Customer
- Model
- Variant
- Colour

###### Pricing

- Ex-showroom Price
- Insurance
- RTO / Registration
- Accessories
- Extended Warranty
- Service Package
- Other Charges

###### Adjustments

- Exchange Value
- Corporate Offer
- Dealer Discount
- Additional Discount

###### Summary

- Vehicle Price
- Add-ons
- Adjustments
- Taxes/TCS where applicable
- Final On-Road Price

Actions:

- Save Draft
- Preview
- Request Approval
- Send WhatsApp
- Send Email

###### Approval rule

If discount is within consultant authority:

**Send directly**

If discount exceeds authority:

**Request Approval**

---

#### 30. Competitor Comparison

Not sidebar.

Open from:

- Customer 360
- Quotation
- Test Drive Feedback

Compare:

- Price
- Engine
- Power
- Torque
- Transmission
- Mileage
- Dimensions
- Boot Space
- Safety
- Features
- Warranty

Show:

- Our Advantages
- Competitor Advantages
- Recommended Talking Points
- AI Suggested Response when AI credits available

---

#### 31. Stock Check

Read-only for Sales Consultant.

###### KPI

- Available Vehicles
- Limited Stock
- Incoming This Week
- Unavailable

###### Filters

- Brand
- Model
- Variant
- Fuel
- Transmission
- Colour
- Branch

###### Table

- Model
- Variant
- Colour
- Available Qty
- Reserved
- Incoming
- Expected Arrival
- Stock Status

Sales Consultant cannot edit stock quantities.

---

#### 32. Exchange

Sales Consultant creates request.

Capture:

- Customer
- Registration
- Brand
- Model
- Variant
- Year
- Fuel
- Ownership
- KM
- RC
- Expected Price
- Photos
- Notes

Statuses:

- Requested
- Inspection Scheduled
- Under Evaluation
- Valuation Ready
- Customer Accepted
- Customer Rejected
- Completed

Final valuation belongs to **Used Car / Exchange Team**, not Sales Consultant.

---

#### 33. Bookings

###### KPI

- Bookings This Month
- Pending Confirmation
- Payment Pending
- Confirmed
- Cancelled

###### Table

- Booking ID
- Customer
- Model
- Variant
- Colour
- Booking Date
- Booking Amount
- Payment Status
- Expected Delivery
- Booking Status
- Action

###### Create booking

- Customer
- Accepted/approved quotation
- Model
- Variant
- Colour
- Booking Amount
- Payment Method
- Payment Reference
- Expected Delivery
- Notes

Once confirmed:

**Booking → Inventory → Finance if required → Insurance → RTO → Delivery**

---

#### 34. Performance — individual page

Sales Consultant sees **personal performance only**.

###### KPI

- Assigned Leads
- Test Drives
- Quotations
- Bookings
- Conversion Rate
- Target Achievement

###### Apache ECharts Line

- Test Drives
- Quotations
- Bookings

###### Apache ECharts Funnel

**Assigned → Test Drive → Quotation → Booking**

###### Target progress

Use shadcn `Progress`:

- Booking Target
- Test Drive Target
- Quotation Target

No leaderboard here.

Manager roles have separate team/branch performance screens.

---

#### 35. Customer 360

Contextual working screen.

###### Header

- Customer Name
- Phone
- Interested Model
- Sales Stage
- Temperature
- Sales Consultant

Quick actions:

**Call | WhatsApp | Follow-up | Test Drive | Quotation | Booking**

###### Customer information

- Name
- Primary Phone
- Alternate Phone
- Email
- DOB
- Anniversary
- Occupation
- Company
- Address
- City
- PIN

###### Vehicle requirement

- Brand
- Model
- Variant
- Fuel
- Transmission
- Colour
- Usage
- Delivery Timeline

###### Budget/preferences

- Budget
- Finance Required
- Exchange Required
- Insurance Preference
- Purchase Type
- Preferred Services

###### Previous vehicles

Multiple records.

###### Previous leads/purchases

Example:

**2024 → Website → Honda City → Delivered**

**2026 → CarWale → Elevate → Current Opportunity**

One Customer UUID remains the source of truth.

###### Sections

- Overview
- Timeline
- Calls
- Conversations
- Follow-ups
- Test Drives
- Quotations
- Bookings
- Documents

---

#### 36. Conversations

Do not maintain a separate WhatsApp sidebar page.

Customer conversations open contextually.

Supported connected channels:

- WhatsApp
- Facebook Messenger
- Instagram DM

All communication goes into Customer/Lead activity history.

---

#### 37. Mobile Home

Show only actionable information:

- Today’s Appointments
- Test Drives Today
- Priority Leads
- Follow-ups Today
- Tasks
- Quotations Awaiting Response

Quick actions:

**Call | WhatsApp | Open Customer | Start Test Drive**

No large charts.

---

#### 38. Mobile My Leads

Card:

- Customer
- Model
- Temperature
- Sales Stage
- Next Follow-up
- Last Activity

Actions:

**Call | WhatsApp**

---

#### 39. Mobile Follow-ups

Tabs:

- Overdue
- Today
- Upcoming

Card:

- Customer
- Model
- Reason
- Time
- Priority

Actions:

**Call | Complete | Reschedule**

---

#### 40. Mobile Appointments

Tabs:

- Today
- Upcoming
- Completed

Card:

- Customer
- Type
- Model
- Time
- Location
- Status

Actions:

**Call | Navigate | Confirm | Start Test Drive**

---

#### 41. Mobile Test Drive

###### Before start

- Customer
- Vehicle
- Registration
- Start Location
- Planned Destination
- Expected Duration
- Start KM

###### During

- Elapsed Time
- Distance
- GPS Status
- Vehicle
- Customer

Button:

**End Test Drive**

###### Completion

- End Location
- End Time
- End KM
- Customer Feedback

Then route summary uploads.

---

#### 42. Mobile Customer Detail

Sections:

- Customer Information
- Vehicle Requirement
- Budget
- Purchase Timeline
- Previous Vehicles
- Previous Leads
- Previous Call Summary
- Follow-up
- Appointment
- Test Drive
- Quotation Summary
- Booking Summary
- Notes
- Recent Activity

Actions:

- Call
- WhatsApp
- Add Note
- Follow-up
- Appointment
- Test Drive
- Quotation
- Stock Check
- Exchange Request
- Booking

---

#### 43. Cache and refresh

Same global CRM rule.

###### TanStack Query

-

```
staleTime = 60 sec
```

1.

```
gcTime = 30 min
```

1.

```
refetchOnWindowFocus = false
```

1.

```
refetchOnReconnect = true
```

###### Manual Refresh

Maximum:

**3 refreshes/minute/user/page-resource**

###### Web

Selected non-sensitive persisted cache:

**IndexedDB**

###### Mobile

Selected non-sensitive persisted cache:

**AsyncStorage**

###### GPS route

**SQLite local buffer**

###### Zustand

Only small/local UI state.

###### Redis/Upstash

Server-side only.

---

#### 44. Final permission summary

| **Capability**                  | **Sales Consultant**            |
| ------------------------------- | ------------------------------- |
| Assigned leads                  | ✅                               |
| Fresh lead queue                | Only with Telecaller permission |
| Customer 360 assigned customers | ✅                               |
| Entire company customer DB      | ❌                               |
| Calls                           | ✅                               |
| Connected chats                 | ✅                               |
| Follow-ups                      | ✅                               |
| Tasks                           | ✅                               |
| Appointments                    | ✅                               |
| Test Drives                     | ✅                               |
| Own GPS                         | ✅                               |
| Track other consultants live    | ❌                               |
| Quotations                      | ✅                               |
| Unlimited discount approval     | ❌                               |
| Stock visibility                | ✅ Read-only                     |
| Stock edit                      | ❌                               |
| Exchange request                | ✅                               |
| Final vehicle valuation         | ❌                               |
| Booking                         | ✅                               |
| Finance processing              | ❌                               |
| Own performance                 | ✅                               |
| Team performance                | ❌                               |

---

#### 45. Hierarchy visibility

Sales Consultant

→ Own performance / own records



Team Manager

→ All Telecallers + Sales Consultants in own team



Showroom Manager

→ All teams and staff in branch



GM

→ Configured branch / multi-branch performance



Business Owner

→ High-level overall performance




---

#### 46. Final Sales Consultant flow

QUALIFIED LEAD

      ↓

ASSIGNMENT MODE

      ↓

ROUND ROBIN / TELECALLER MANUAL ASSIGN

      ↓

SALES CONSULTANT

      ↓

CUSTOMER 360

      ↓

FOLLOW-UP / SHOWROOM VISIT

      ↓

TEST DRIVE

      ↓

FEEDBACK

      ↓

QUOTATION

      ↓

STOCK CHECK

      ↓

EXCHANGE IF REQUIRED

      ↓

NEGOTIATION / APPROVAL

      ↓

BOOKING

      ↓

DOWNSTREAM DEPARTMENTS



And if the consultant also has Telecaller capability:

NEW LEAD

↓

CONTACT

↓

QUALIFY

↓

SAME USER CONTINUES AS SALES CONSULTANT

↓

TEST DRIVE

↓

QUOTATION

↓

BOOKING



**This is the version you should copy and keep as the final Sales Consultant PRD.** It includes the corrected Round Robin/manual assignment rule, manager performance visibility, hybrid Telecaller+Sales role, and optimized test-drive GPS design.

Use this exact section:

###### Final Telecaller Assignment & Performance Rule

**Performance Visibility**

- Telecaller → own performance only
- Team Manager → all Telecallers + Sales Consultants in own team
- Showroom Manager → all teams/users in own branch
- GM → configured branch/multi-branch performance

**Qualified Lead Assignment**

- Team Manager configures the team assignment mode:
  - **Round Robin** → CRM automatically assigns the next eligible Sales Consultant
  - **Manual Assignment** → Telecaller selects an eligible Sales Consultant from their permitted team/branch
- Team Manager can reassign within own team
- Showroom Manager can override/reassign within branch
- Every assignment change stores previous owner, new owner, assigned by, assignment method, date/time and reason
- If the same user has both **Telecaller + Sales Consultant** capability, they can continue as the Sales Consultant after qualification without transferring the lead to themselves


### 54.3 Team Manager — detailed page PRD

#### Team Manager — Final Web PRD

##### 1. Final Hierarchy

There is **no Team Leader** now.

GM Sales Executive

        ↓

Showroom Manager

        ↓

Team Manager

        ↓

 ┌───────────────┬───────────────────┐

 Sales Consultant   Telecaller / BDC



Team Manager directly manages both roles.

The role is not hard-coded to one branch.

When assigning a Team Manager user:

ONE BRANCH

SELECTED BRANCHES

ALL BRANCHES



and then permitted teams inside that scope are assigned.

---

#### 2. Team Manager — Final Web Sidebar

1. **Dashboard**
2. **Team Leads**
3. **Lead Assignment**
4. **Follow-ups**
5. **Team Calls**
6. **Appointments**
7. **Test Drives**
8. **Quotations**
9. **Bookings**
10. **Team Performance**
11. **Lost Leads**
12. **Escalations**
13. **Reports**

###### Contextual — not sidebar

- Customer 360
- Lead Detail
- Call Detail
- Recording / Transcript
- Appointment Detail
- Test Drive Detail
- Test Drive Map / Live Tracking
- Quotation Detail
- Booking Detail
- Consultant Performance Detail
- Assignment History
- Conversation History

###### Removed

**Tasks** is removed from Team Manager sidebar for MVP.

Reason: Team Manager already manages work through:

**Lead Assignment + Follow-ups + Appointments + Escalations + Notifications**

A separate generic Tasks page would duplicate these workflows.

No Team Manager mobile module for now.

---

#### 3. Lead Status Rule

This needs to remain clean.

Do **not** convert the real lifecycle from `New` to `Pending` just because time passed.

###### Actual Lead Lifecycle

New

Contacted

Qualified

Appointment Scheduled

Transferred to Sales

Lost



Sales activity can separately progress through:

Test Drive

Quotation

Booking




###### Derived Work State

If lead has not been contacted:

| **Age**               | **Work State** |
| --------------------- | -------------- |
| < 24 hours            | New Today      |
| ≥ 24 hours            | Pending        |
| Beyond configured SLA | SLA Risk       |

Example:

Lifecycle: New

Work State: Pending

Lead Age: 1d 7h

Contact Status: Not Contacted



So yes, the UI can visibly show **Pending**, but `Pending` is not the permanent lifecycle value.

---

#### 4. Dashboard

Purpose:

> What is happening in my team and what requires attention?

###### KPI Cards

- Total Active Leads
- Uncontacted Leads
- Hot Leads
- Overdue Follow-ups
- Calls Today
- Test Drives
- Quotations
- Bookings
- Team Conversion %

Use **shadcn Card**.

###### Attention Required

Show:

- New Leads Not Contacted
- Pending Leads
- SLA Risk Leads
- Overdue Follow-ups
- Hot Leads Inactive
- Test Drive Completed — Quotation Pending
- Quotation Awaiting Response

Clicking a card opens the appropriate filtered page.

###### Team Funnel

Use **Apache ECharts Funnel**:

Assigned Leads

↓

Contacted

↓

Qualified

↓

Test Drive

↓

Quotation

↓

Booking




###### Daily Activity

Use **Apache ECharts Line**:

- Calls
- Connected Calls
- Test Drives
- Quotations
- Bookings

###### Team Overview Table

User

Role

Active Leads

Calls

Follow-ups Due

Qualified

Test Drives

Quotations

Bookings

Conversion %

Target %



Role filter:

All

Telecaller

Sales Consultant




---

#### 5. Team Leads

This is the Team Manager's **team monitoring page**.

It is not intended to replace Telecaller/Sales Consultant working pages.

Team Manager can see all leads belonging to permitted teams.

###### KPI

- Total Team Leads
- New Today
- Pending
- SLA Risk
- Hot Leads
- Follow-ups Due

###### Filters

- Search
- Assigned User
- Role
- Source
- Model
- Lifecycle
- Work State
- Temperature
- SLA
- Created Date
- Branch
- Team

Only assigned branches/teams appear.

###### Table

Lead ID

Customer

Phone

Assigned User

Role

Source

Interested Model

Lifecycle

Work State

Temperature

Last Activity

Next Follow-up

Lead Age

SLA

Action




###### Team Manager Actions

Default:

- Open
- View Customer 360
- Reassign
- Change Priority
- Add Manager Note
- View Assignment History

Routine customer-data editing stays with the lead owner.

Manager overrides should be audited.

---

#### 6. Lead Assignment — Important

This is where the Team Manager handles **raw/unassigned + assigned leads**.

And yes:

##### Default mode = Round Robin

Team Manager can switch/configure:

ROUND ROBIN

MANUAL ASSIGNMENT



I would remove the third generic "Auto Assignment" mode from your reference because Round Robin already covers the default automatic distribution we need for MVP.

---

#### 7. Two Assignment Queues

We need two logical queues.

###### A. Fresh Lead Assignment

Incoming Lead

↓

Unassigned

↓

Telecaller



Eligible users:

**Telecaller / BDC**

or hybrid users who also have Telecaller capability.

###### B. Qualified Lead Assignment

Telecaller Qualifies

↓

Sales Assignment

↓

Sales Consultant



Eligible:

**Sales Consultant**

or hybrid users with Sales capability.

---

#### 8. Round Robin

Team Manager chooses Round Robin for that team.

CRM assigns the next eligible user.

Eligibility checks:

- Correct branch
- Correct team
- Correct capability
- Active account
- Assignment enabled
- Not excluded from rotation

Example:

Telecaller A

Telecaller B

Telecaller C



Lead 1 → A

Lead 2 → B

Lead 3 → C

Lead 4 → A



For Sales:

Qualified Lead 1 → Sales A

Qualified Lead 2 → Sales B

Qualified Lead 3 → Sales C




---

#### 9. Manual Assignment

Team Manager can manually select:

**Lead → Assign → Eligible User**

Telecaller can also manually select a Sales Consultant after qualification when the team's assignment mode allows it.

Team Manager can always reassign within their permitted scope.

---

#### 10. Lead Assignment Page

###### Tabs

Unassigned

Assigned

Qualified Awaiting Sales

Assignment History




###### Unassigned table

Lead ID

Created

Customer

Phone

Source

Model

Temperature

Lead Age

Work State

Preferred Branch

Action




###### Assigned table

Lead ID

Customer

Current Owner

Role

Assigned At

Assignment Method

Stage

Next Follow-up

Action




###### Eligible Users panel

Show:

User

Role

Current Lead Load

Hot Leads

Calls Today

Availability

Assignment Eligibility




###### Assignment History

Store:

Lead

Previous Owner

New Owner

Assigned By

Assignment Method

Date & Time

Reason

Branch

Team



Assignment methods:

Round Robin

Manual by Telecaller

Manual by Team Manager

Reassigned by Team Manager

Manager Override




---

#### 11. Follow-up Monitor

Team Manager sees follow-ups of all permitted Telecallers and Sales Consultants.

###### KPI

- Due Today
- Overdue
- Completed Today
- Missed

###### Filters

- User
- Role
- Priority
- Follow-up Status
- Follow-up Date
- Model
- Team

###### Table

Responsible User

Role

Customer

Phone

Model

Follow-up Date

Follow-up Time

Reason

Delay

Priority

Previous Note

Status

Action



Statuses:

Pending

Completed

Rescheduled

Missed




###### Manager actions

- Open Lead
- Open Customer
- Remind User
- Reassign Owner
- View History

Team Manager should **not routinely mark another user's follow-up completed**.

If override permission is used, store:

`Completed by Manager Override`.

---

#### 12. Team Calls

Reference your Team Call Monitor screen, but tie it directly to Customer 360.

###### KPI

- Total Calls
- Connected
- Missed / No Answer
- Total Talk Time
- Average Duration
- Connection Rate

###### Apache ECharts Line

Total Calls

Connected Calls




###### User Performance Table

User

Role

Total Calls

Connected

Connection Rate

Talk Time

Average Duration

Follow-ups Created

Qualified Leads / Bookings from Calls




---

#### 13. Call History Table

Customer

Phone

Lead ID

Caller

Role

Call Type

Provider

Date & Time

Duration

Outcome

Recording

Transcript

AI Summary

Sync Status

Action



Clicking:

**Customer / Lead**

opens:

**Customer 360 → Calls tab**

Not a disconnected separate screen.

---

#### 14. Call Recording Storage

Do not keep provider recording URLs permanently.

Flow:

IVR / Calling Provider

       ↓

Sync Call

       ↓

Backend

       ↓

Fetch metadata

       ↓

Fetch recording securely

       ↓

Private Object Storage

       ↓

CRM Call Record



With our current stack:

**Tigris Data private S3-compatible bucket**

Design the storage layer behind an adapter so changing S3-compatible vendors later doesn't change CRM logic.

###### Never

Browser → Provider Secret

Browser → Permanent Provider Recording URL



Provider credentials remain server-side.

---

#### 15. Sync Call

Manager can press:

**Sync Call**

or normal background sync handles it automatically.

Use **Trigger.dev**.

Job:

sync-provider-call



It fetches:

- Provider Call ID
- Status
- Start/end time
- Duration
- Disposition
- Recording
- Transcript if available

Use `provider_call_id` for idempotency.

If already synced:

**do not create duplicate recordings.**

---

#### 16. Recording Security

Recording file:

**Private Storage**

Database stores:

- storage key
- MIME
- file size
- checksum
- provider call ID
- created time

Authorized user presses Play.

Backend provides a **short-lived signed URL**.

Do not make recordings public.

---

#### 17. Transcript + AI

Transcript and AI summary are visible in Call Detail.

Viewing an existing transcript/summary:

**No new AI credit consumption.**

Actions such as:

- Generate transcript
- Regenerate transcript
- Generate AI summary
- Extract CRM fields

consume dealership AI credits.

AI still cannot silently modify CRM fields.

---

#### 18. Appointments

Team Manager sees appointments created by users in the team.

Appointment types:

Showroom Visit

Test Drive




###### KPI

- Today
- Upcoming
- Confirmed
- Arrived
- Completed
- No Show

###### Table

Customer

Phone

Appointment Type

Model

Date

Time

Branch

Assigned Consultant

Created By

Confirmation Status

Attendance

Arrival Time

Status

Action




###### Attendance

Not Arrived

Arrived

Completed

No Show



This lets Team Manager see **who actually attended**.

###### Manager actions

- Open
- Reassign Consultant
- Reschedule
- Add Manager Note

---

#### 19. Test Drives

Team Manager sees all test drives for permitted team scope.

###### KPI

- Today
- Upcoming
- Active
- Completed
- Cancelled
- Conversion After Test Drive

###### Table

Customer

Sales Consultant

Vehicle

Registration

Start Time

Expected End

Status

GPS Status

Distance

Feedback

Quotation Status

Action



Tabs:

Today

Upcoming

Active

Completed

Cancelled




---

#### 20. Test Drive Map

Press:

**View Test Drive**

Open map.

For completed drives:

- Start marker
- Destination/reached marker
- Completion marker
- Simplified route
- Start time
- End time
- Duration
- Distance
- Start KM
- End KM

No continuous live GPS required for completed drives.

---

#### 21. Optimized Active Test Drive Tracking

This is now the final design.

Normally:

Sales Consultant Device

↓

GPS recorded locally

↓

SQLite route buffer

↓

No continuous server upload



Server immediately receives only important anchor points:

- Start
- Reached destination if used
- Completion

---

#### 22. Team Manager — Live Snapshot

When Team Manager opens an active test drive:

**Get Current Location**

Backend requests location from the Sales Consultant mobile device.

Manager receives current point.

While the map remains open, enable low-frequency refresh:

**maximum approximately once every 10 minutes by default.**

This is the low-cost mode.

---

#### 23. Real-Time Boost

If Team Manager needs actual real-time viewing:

Button:

**Real-Time Boost — 1 Minute**

For one minute:

Manager

↓

Starts Boost

↓

Consultant app sends temporary live points

↓

Manager sees moving marker

↓

1 minute ends

↓

Auto Stop



Target update frequency:

approximately **5–10 seconds**, depending on phone/network/OS.

After 1 minute:

**automatic stop.**

No forgotten live tracking session running for hours.

---

#### 24. Use Realtime Instead of Writing Every GPS Point

For that 1-minute live session:

Use **Supabase Realtime Broadcast**.

Do not insert every GPS ping into PostgreSQL.

Concept:

Consultant Device

       ↓

Realtime Broadcast Channel

       ↓

Team Manager Browser



Only important anchors / final route go into permanent storage.

This reduces:

- DB writes
- storage
- server load
- query load

considerably.

---

#### 25. Tracking Credits

Do **not** use AI credits for GPS.

Keep a separate optional:

**Live Tracking Credit / Usage Quota**

Example:

- Normal Snapshot → no credit
- 10-minute low-frequency view → no/very low usage
- 1-minute Real-Time Boost → consumes configured tracking credit

Super Admin can configure usage/billing later.

This keeps AI billing separate from GPS infrastructure billing.

---

#### 26. Tracking Failure

If mobile cannot respond:

Live Location Unavailable



Show:

Last Known Location

Last Updated Time

GPS Permission State if known



Possible causes:

- App killed
- No internet
- GPS disabled
- Background permission denied
- Phone switched off

Never label stale coordinates as `Live`.

---

#### 27. Quotations

Team Manager sees quotations from their team.

###### Default permission

**Read-only monitoring.**

###### KPI

- Total
- Sent
- Revised
- Approval Pending
- Expiring Soon

###### Table

Quote ID

Customer

Sales Consultant

Model

Variant

On-Road Price

Discount

Created

Last Sent

Status

Approval Status

Action




###### Manager can

- View
- Open Customer
- View revision history
- View discount
- See approval status

---

#### 28. Quotation Approval

By default Team Manager **cannot edit quotation pricing/master values**.

Vehicle pricing comes from authorized master data.

If an explicit permission is later granted:

quotation.approve\_discount



then Team Manager gets:

Approve

Reject

Return for Revision



only within configured approval limit.

Otherwise page stays read-only.

---

#### 29. Bookings

Team Manager monitors team bookings.

###### KPI

- Pending
- Confirmed
- Stock Awaited
- Allocated
- Ready for Delivery
- Delivered
- Cancelled

###### Table

Booking ID

Customer

Sales Consultant

Model

Variant

Colour

Booking Amount

Booking Date

Payment Status

Stock Status

Expected Delivery

Booking Status

Action



Default Team Manager actions:

- View
- Open Customer
- View booking history
- Add manager note
- Escalate issue

Team Manager does **not** perform:

- Finance processing
- Insurance processing
- RTO processing
- Inventory allocation changes

unless a separate permission is explicitly granted.

---

#### 30. Team Performance

This is different from Telecaller/Sales Consultant personal performance.

Team Manager sees:

**all Telecallers + Sales Consultants in their team scope.**

###### Filters

- Date
- Role
- User
- Branch
- Team

###### KPI

- Team Conversion
- Leads Contacted
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Target Achievement

---

#### 31. Performance Charts

###### Apache ECharts Line

Team activity:

Calls

Qualified Leads

Test Drives

Quotations

Bookings




###### Apache ECharts Funnel

Assigned

↓

Contacted

↓

Qualified

↓

Test Drive

↓

Quotation

↓

Booking




###### Apache ECharts Bar

User comparison:

Telecaller / Sales Consultant

vs

Conversion / Target




---

#### 32. Performance Table

User

Role

Assigned Leads

Calls

Connected

Qualified

Follow-ups Completed

Test Drives

Quotations

Bookings

Conversion %

Target %



Click user:

**Consultant Performance Detail**

This is contextual.

---

#### 33. Lost Leads

Team Manager sees lost leads for their team.

###### KPI

- Total Lost
- Lost This Week
- Recoverable
- High-value Lost
- Recovery %

###### Filters

- Date
- User
- Role
- Source
- Model
- Loss Reason
- Competitor
- Temperature

###### Lost Reason

Examples:

Price

Chose Competitor

Budget

Feature Missing

Finance Issue

Delivery Delay

Stock Unavailable

No Response

Service Concern

Other




###### Table

Lead ID

Customer

Owner

Source

Model

Lost Date

Lead Age

Loss Reason

Competitor

Last Note

Recovery Score

Action



Actions:

- Open
- Reopen for Recovery
- Assign Recovery Owner
- Add Manager Note

---

#### 34. Lost Lead Analytics

Use **Apache ECharts Donut**:

**Loss Reasons**

Use **Apache ECharts Bar**:

**Competitor-wise Lost Leads**

No separate charting library.

---

#### 35. Escalations

Team Manager handles first-level team/customer escalations.

###### Tabs

New

In Progress

Resolved

Escalated




###### KPI

- New
- In Progress
- Resolved Today
- SLA Risk

###### Table

Escalation ID

Customer

Lead

Responsible User

Issue

Priority

SLA

Created

Status

Action




###### Actions

- Assign
- Comment
- Resolve
- Escalate Upward

Escalating upward routes to the configured higher manager such as Showroom Manager.

---

#### 36. Escalation Detail

Use `shadcn Sheet`.

Show:

- Customer
- Lead
- Responsible Consultant/Telecaller
- Priority
- SLA
- Description
- Attachments
- Customer History
- Comments
- Activity

Every manager action is audited.

---

#### 37. Reports

Team Manager gets **team-scoped reports only**.

Report types:

Lead Funnel

Lead Source Performance

Telecaller Performance

Sales Consultant Performance

Follow-up Compliance

Call Performance

Test Drive Performance

Quotation Conversion

Booking Conversion

Lost Lead Analysis

SLA Performance



Filters:

- Date range
- Branch
- Team
- Role
- User
- Source
- Model

Exports can run through **Trigger.dev** if report generation is heavy.

---

#### 38. Table Standard — Important

Every major Team Manager list uses:

**shadcn Table + TanStack Table**

Do **not** load the whole dataset into the browser.

All filtering/sorting/search/pagination is server-side.

---

#### 39. Page-local Search Only

For every table:

Search applies only to **that page/resource**.

Example Team Leads search:

Lead ID

Customer Name

Normalized Phone



It should not search quotations, calls, bookings and the whole CRM simultaneously.

This keeps queries fast and predictable.

---

#### 40. Debounced Search

Use approximately:

300 ms debounce



Flow:

User types

↓

300ms wait

↓

Cancel obsolete query

↓

Send latest indexed server query



TanStack Query manages request lifecycle.

Do not fire a database request on every keystroke.

---

#### 41. PostgreSQL Search Indexing

For exact/scoped filtering, use B-tree indexes around actual query patterns.

Examples conceptually:

tenant\_id

branch\_id

team\_id

assigned\_user\_id

lifecycle\_status

created\_at

followup\_date

normalized\_phone



Common composite patterns:

tenant\_id + team\_id + created\_at

tenant\_id + team\_id + assigned\_user\_id

tenant\_id + team\_id + lifecycle\_status

tenant\_id + team\_id + followup\_date



RLS still enforces tenant/data scope.

---

#### 42. Strong Customer Name Search

Yes — use PostgreSQL:

```
pg_trgm
```

with a **GIN trigram index** for customer-name fuzzy search.

Example:

Typing:

Rav Ver



can still find:

Rahul Verma

Ravi Verma



without running a slow `%text%` full-table scan.

Phone search uses normalized number indexing instead.

Lead ID uses exact/prefix indexed search.

---

#### 43. Do Not Abuse Trigram Indexes

Use trigram for fields where fuzzy matching is useful:

- Customer Name
- Possibly Company Name

Do not add trigram indexes to every database column.

Model/source/status use proper dropdown filters and B-tree indexes.

---

#### 44. Pagination

All large tables use **server-side pagination**.

Default:

25 rows/page



Options:

25

50

100



Server returns only the requested page.

Never download 10,000 leads and paginate in JavaScript.

---

#### 45. Virtualization

Do not blindly virtualize a 25-row table because it gives almost no benefit.

Use **TanStack Virtual** for:

- 100-row/high-density tables
- Long activity timelines
- Long call transcript lists
- Large consultant/lead selection panels

Normal 25/50-row paginated tables can render normally.

So we support virtualization where it actually reduces DOM cost.

---

#### 46. Sorting

Server-side sorting only on approved/index-friendly columns such as:

Created At

Lead Age

Follow-up Date

Priority

Status

Customer

Booking Date

Call Date



Do not allow arbitrary SQL column names from the browser.

Frontend sends a predefined sort key.

---

#### 47. Data Fetching

Use:

**TanStack Query**

Query key concept:

team-leads

tenant

scope

branch

team

filters

sort

page



Changing only one filter invalidates/refetches only that dataset.

Do not reload the entire Team Manager application.

---

#### 48. Cache Rule

Same CRM standard:

staleTime = 60 seconds

gcTime = 30 minutes

refetchOnWindowFocus = false

refetchOnReconnect = true



Manual Refresh:

**maximum 3 refreshes/minute/user/page-resource**

---

#### 49. Lazy Loading

To keep Team Manager fast:

- Call transcript loads only when Call Detail opens
- Recording signed URL generated only when playback requested
- Map SDK loads only when Test Drive Map opens
- Full activity timeline loads when Customer 360 opens
- ECharts loaded per analytics page
- Large report generation happens in background

Do not load all heavy resources on Dashboard.

---

#### 50. Storage

Use Tigris Data private S3-compatible buckets for:

- Call recordings
- Test drive route files if needed
- Escalation attachments
- Customer documents

Store business metadata in PostgreSQL.

Do not store binary recordings directly inside Postgres.

---

#### 51. Trigger.dev Usage

Use Trigger.dev for jobs such as:

IVR call synchronization

Recording ingestion

Provider retries

AI transcription requests

AI summaries

Large report generation

Background exports

Delayed SLA jobs



Do not use Trigger.dev for real-time GPS streaming.

GPS live boost uses **Supabase Realtime**.

---

#### 52. Team Manager Permissions

| **Capability**                             | **Team Manager**         |
| ------------------------------------------ | ------------------------ |
| View team leads                            | ✅                        |
| View raw/unassigned leads in allowed queue | ✅                        |
| Assign leads                               | ✅                        |
| Configure team Round Robin                 | ✅                        |
| Manual assign                              | ✅                        |
| Reassign within scope                      | ✅                        |
| View Telecaller performance                | ✅                        |
| View Sales Consultant performance          | ✅                        |
| View team calls                            | ✅                        |
| Listen to permitted recordings             | ✅                        |
| Sync IVR calls                             | ✅                        |
| View team follow-ups                       | ✅                        |
| View appointments                          | ✅                        |
| Reassign consultant appointment            | ✅                        |
| View test drives                           | ✅                        |
| Request current location                   | ✅                        |
| 1-minute live tracking boost               | ✅ with permission        |
| View quotations                            | ✅                        |
| Edit pricing master                        | ❌                        |
| Approve quotation discount                 | Only explicit permission |
| View bookings                              | ✅                        |
| Perform Finance/RTO/Insurance              | ❌                        |
| Edit inventory                             | ❌                        |
| View lost leads                            | ✅                        |
| Recover/reassign lost lead                 | ✅                        |
| Resolve first-level escalation             | ✅                        |
| View team reports                          | ✅                        |
| View another unrelated team                | ❌ unless assigned scope  |
| Create/change system roles                 | ❌                        |
| Create organization-wide users             | ❌ by default             |

---

#### 53. Data Scope Rule

Very important:

ROLE

    ≠

BRANCH



Example:

Role: Team Manager

Scope: MG Road Branch

Teams: Team A



or:

Role: Team Manager

Scope: MG Road + Whitefield

Teams: A, B, C



or:

Role: Team Manager

Scope: All Branches

Teams: Selected permitted teams



The branch selector only filters data the user is **already authorized to access**.

It never grants new access.

---

#### 54. RLS Rule

Every query remains protected server-side with Supabase RLS.

Concept:

Tenant Match

\+

Assigned Branch Scope

\+

Assigned Team Scope

\+

Permission



Frontend hiding a button is not considered security.

Backend/RLS is the enforcement layer.

---

#### 55. Final Team Manager Flow

RAW LEADS

    ↓

UNASSIGNED QUEUE

    ↓

ROUND ROBIN / MANUAL ASSIGNMENT

    ↓

TELECALLER

    ↓

CONTACT / QUALIFICATION

    ↓

QUALIFIED

    ↓

ROUND ROBIN / MANUAL SALES ASSIGNMENT

    ↓

SALES CONSULTANT

    ↓

APPOINTMENT

    ↓

TEST DRIVE

    ↓

QUOTATION

    ↓

BOOKING



Throughout this process:

TEAM MANAGER

     │

     ├── monitors Team Leads

     ├── controls assignments

     ├── monitors follow-ups

     ├── monitors calls

     ├── checks appointments

     ├── tracks test drives

     ├── views quotations

     ├── monitors bookings

     ├── reviews team performance

     ├── handles lost leads

     └── handles escalations



And the important optimization is:

**table data stays server-paginated and indexed; fuzzy customer search uses** **`pg_trgm`****; searches are debounced; heavy data is lazy-loaded; IVR sync uses Trigger.dev; recordings stay private; and real-time test-drive GPS only runs when an authorized manager requests it, with a 1-minute boost instead of continuously hitting the database.**

This can now be treated as the **final Team Manager Web PRD** before we move upward to **Showroom Manager**.


### 54.4 Showroom Manager — detailed page PRD

##### SHOWROOM MANAGER — FINAL WEB PRD

##### 1. Role Purpose

Showroom Manager manages the complete sales operation inside their assigned scope.

Final hierarchy:

**GM Sales Executive → Showroom Manager → Team Manager → Sales Consultant + Telecaller/BDC**

There is **no Team Leader**.

Showroom Manager supervises:

- Team Managers
- Telecallers / BDC
- Sales Consultants
- Lead flow
- Assignments
- Follow-ups
- Calls
- Appointments
- Test Drives
- Quotations
- Bookings
- Approvals
- Targets
- Performance
- Lost Leads
- Escalations

Operational departments are coordinated from the showroom level, but are not automatically controlled by Showroom Manager.

---

#### 2. Data Scope

Showroom Manager role is not fixed to only one branch.

When assigning the user:

**ONE\_BRANCH | SELECTED\_BRANCHES | ALL\_BRANCHES**

Example:

**Showroom Manager A**

- Branch A only

or:

**Showroom Manager B**

- Branch A
- Branch B
- Branch C

or:

**Showroom Manager C**

- All branches

Also assign permitted teams.

Important:

**Branch/team selectors are filters only. They never increase permission.**

If `ALL_BRANCHES` is selected:

**branch selector is disabled and cleared.**

If `ONE_BRANCH` or `SELECTED_BRANCHES` is selected:

`ALL_BRANCHES` cannot also be selected.

---

#### 3. Current MVP

**Showroom Manager = Web only**

No separate Showroom Manager mobile app for current MVP.

---

#### 4. Final Sidebar

1. **Dashboard**
2. **Showroom Leads**
3. **Lead Assignment**
4. **Follow-ups**
5. **Team Calls**
6. **Appointments**
7. **Test Drives**
8. **Quotations**
9. **Bookings**
10. **Approvals**
11. **Sales Teams**
12. **Showroom Targets**
13. **Performance**
14. **Lost Leads**
15. **Escalations**
16. **Reports**

Optional:

**17. Users**

Only when Client Admin grants User Management permission.

---

#### 5. Contextual Pages

Do not put these in sidebar:

- Customer 360
- Lead Detail
- Call Detail
- Recording / Transcript
- Appointment Detail
- Test Drive Detail
- Live Tracking
- Quotation Detail
- Booking Detail
- Approval Detail
- Team Manager Detail
- Sales Consultant Performance Detail
- Telecaller Performance Detail
- Assignment History
- Conversation History
- Operational Status Detail

---

#### 6. Dashboard

Purpose:

**Showroom Manager should immediately know what is happening across all teams in their scope.**

###### KPI Cards

- Active Leads
- New Leads Today
- Pending Leads
- SLA Risk
- Qualified Leads
- Follow-ups Overdue
- Test Drives Today
- Quotations Pending
- Bookings This Month
- Target Achievement

Use **shadcn Card**.

###### Requires Attention

Show:

- New Leads Not Contacted
- Pending Leads
- SLA Risk Leads
- Overdue Follow-ups
- Hot Leads Without Recent Activity
- Test Drive Completed but Quotation Pending
- Quotation Awaiting Approval
- Booking Waiting for Stock
- Escalations Near SLA

Clicking any item opens the appropriate filtered page.

---

#### 7. Dashboard Sales Funnel

Use **Apache ECharts Funnel**:

**Assigned → Contacted → Qualified → Test Drive → Quotation → Booking**

This represents the sales journey.

Do not use Hot/Warm/Cold in this funnel.

---

#### 8. Dashboard Activity Trend

Use **Apache ECharts Line**:

- Calls
- Connected Calls
- Qualified Leads
- Test Drives
- Quotations
- Bookings

Filter:

- Today
- 7 Days
- 30 Days
- Custom Range

---

#### 9. Team Overview

Table:

- Team Manager
- Team
- Telecallers
- Sales Consultants
- Active Leads
- Calls
- Follow-ups Due
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Conversion %
- Target %

Click Team Manager:

**Team Performance Detail**

---

#### 10. Operational Snapshot

Even without operational-module permissions, Showroom Manager can see read-only booking-related statuses.

Example:

- Finance Pending
- Insurance Pending
- RTO Pending
- Vehicle Allocation Pending
- Exchange Pending
- Deliveries Due

Clicking opens relevant customer/booking status.

They cannot process those departments unless permission is granted separately.

---

#### 11. Showroom Leads

This is the Showroom Manager's **complete lead monitoring page**.

It shows leads belonging to all permitted Team Managers/teams.

It is not a new lead source page.

###### KPI

- Total Leads
- New Today
- Pending
- SLA Risk
- Hot Leads
- Follow-ups Due
- Qualified
- Lost

---

#### 12. Lead Lifecycle vs Work State

Keep these separate.

###### Lifecycle

- New
- Contacted
- Qualified
- Appointment Scheduled
- Transferred / Sales Stage
- Lost

###### Derived Work State

If not contacted:

**<24h → New Today**

**≥24h → Pending**

If SLA threshold exceeded:

**SLA Risk**

Example:

**Lifecycle: New**
**Work State: Pending**
**Lead Age: 1d 3h**

So Pending is not a lifecycle status.

---

#### 13. Showroom Leads Filters

- Search
- Branch
- Team
- Team Manager
- Assigned User
- Role
- Source
- Campaign
- Model
- Lifecycle
- Work State
- Temperature
- SLA
- Created Date
- Follow-up Date

Only authorized branches/teams appear.

---

#### 14. Showroom Leads Table

Columns:

- Lead ID
- Customer
- Phone
- Branch
- Team
- Team Manager
- Assigned User
- Role
- Source
- Model
- Lifecycle
- Work State
- Temperature
- Last Activity
- Next Follow-up
- Lead Age
- SLA
- Action

Actions:

- Open
- Customer 360
- Reassign
- Move Team
- Add Manager Note
- View Assignment History

---

#### 15. Lead Assignment

Showroom Manager has a broader assignment view than Team Manager.

Tabs:

- Unassigned
- Assigned
- Qualified Awaiting Sales
- Assignment Rules
- Assignment History

---

#### 16. Raw / Unassigned Leads

These are incoming leads not yet allocated.

Table:

- Lead ID
- Created At
- Customer
- Phone
- Source
- Campaign
- Model
- Preferred Branch
- Lead Age
- Work State
- SLA
- Action

Showroom Manager can:

- Assign to Team
- Assign to Telecaller
- Apply Round Robin
- Move to another permitted team

---

#### 17. Qualified Awaiting Sales

Table:

- Lead
- Customer
- Telecaller
- Team
- Qualified At
- Model
- Temperature
- Appointment
- Sales Consultant
- Action

Actions:

- Assign Sales Consultant
- Reassign
- Open Customer

---

#### 18. Assignment Rules

Default assignment mode:

**Round Robin**

Team Manager normally configures assignment mode for their team.

Showroom Manager can override when needed.

Supported:

###### Round Robin

CRM assigns next eligible user.

###### Manual Assignment

Eligible user is selected manually.

---

#### 19. Fresh Lead Assignment

Flow:

**Incoming Lead → Team → Telecaller**

Eligible:

- Telecaller
- Hybrid Telecaller + Sales Consultant user

---

#### 20. Qualified Lead Assignment

Flow:

**Telecaller Qualifies → Sales Assignment → Sales Consultant**

When manual assignment is enabled:

Telecaller can select eligible Sales Consultant.

When Round Robin is enabled:

CRM chooses automatically.

Showroom Manager can override either.

---

#### 21. Assignment History

Every assignment change stores:

- Lead ID
- Previous Team
- New Team
- Previous Owner
- New Owner
- Assigned By
- Assignment Method
- Reason
- Branch
- Date/Time

Methods:

- Round Robin
- Manual by Telecaller
- Manual by Team Manager
- Manual by Showroom Manager
- Reassignment
- Manager Override

---

#### 22. Follow-ups

Showroom Manager sees follow-ups across all permitted teams.

###### KPI

- Due Today
- Overdue
- Completed Today
- Missed
- Rescheduled

###### Filters

- Branch
- Team
- User
- Role
- Priority
- Status
- Date
- Model

###### Table

- User
- Role
- Team
- Customer
- Phone
- Model
- Follow-up Date
- Time
- Reason
- Previous Note
- Priority
- Delay
- Status
- Action

Actions:

- Open Lead
- Customer 360
- Remind User
- Reassign Owner
- View History

Showroom Manager should not routinely complete another user's follow-up.

If override is used:

store **Manager Override** in audit history.

---

#### 23. Team Calls

Showroom Manager sees all permitted team call activity.

###### KPI

- Total Calls
- Connected Calls
- Connection Rate
- Total Talk Time
- Average Duration
- No Answer
- Callbacks Required

###### Apache ECharts Line

- Total Calls
- Connected Calls

###### Team/User Table

- User
- Role
- Team
- Calls
- Connected
- Connection Rate
- Talk Time
- Average Duration
- Follow-ups Created
- Qualified Leads
- Bookings Influenced

---

#### 24. Call History

Columns:

- Customer
- Lead ID
- Caller
- Role
- Team
- Provider
- Call Type
- Date/Time
- Duration
- Outcome
- Recording
- Transcript
- AI Summary
- Sync Status
- Action

Clicking customer opens:

**Customer 360 → Calls**

---

#### 25. Call Recording Storage

Provider recordings must be copied into private CRM storage.

Flow:

**IVR Provider → Sync Call → Backend → Private Storage → CRM Call Record**

Use:

**Tigris Data private S3-compatible bucket**

Keep the storage abstraction S3-compatible.

Database stores metadata only.

Never store permanent public provider URLs.

---

#### 26. Sync Call

Use **Trigger.dev**.

Sync retrieves:

- Provider Call ID
- Status
- Start Time
- End Time
- Duration
- Outcome
- Recording
- Transcript

Must be idempotent.

Same provider call cannot create duplicate recordings.

---

#### 27. Call Security

Authorized user clicks Play.

Backend issues a short-lived signed URL.

Recordings remain private.

---

#### 28. AI Call Intelligence

Existing transcript/summary viewing consumes no new AI credit.

Actions consuming credits:

- Generate Transcript
- Regenerate Transcript
- Generate AI Summary
- Extract CRM Fields

Credits come from the dealership AI wallet.

AI cannot silently modify CRM data.

---

#### 29. Appointments

Appointment types:

- Showroom Visit
- Test Drive

###### KPI

- Today
- Upcoming
- Confirmed
- Arrived
- Completed
- No Show

###### Table

- Customer
- Phone
- Type
- Model
- Date
- Time
- Branch
- Team
- Sales Consultant
- Created By
- Confirmation
- Attendance
- Arrival Time
- Status
- Action

Attendance:

- Not Arrived
- Arrived
- Completed
- No Show

Actions:

- Open
- Reassign Consultant
- Reschedule
- Add Manager Note

---

#### 30. Test Drives

###### KPI

- Today
- Upcoming
- Active
- Completed
- Cancelled
- Conversion After Test Drive

###### Tabs

- Today
- Upcoming
- Active
- Completed
- Cancelled

###### Table

- Customer
- Consultant
- Team
- Vehicle
- Registration
- Start Time
- Expected End
- Status
- GPS Status
- Distance
- Feedback
- Quotation Status
- Action

---

#### 31. Completed Test Drive Map

Show:

- Start Location
- Destination / Reached Point
- End Location
- Route
- Start Time
- End Time
- Duration
- Distance
- Start KM
- End KM

Route stored as simplified/compressed route.

---

#### 32. Active Test Drive Tracking

Do not continuously send GPS to server.

Sales Consultant mobile:

**GPS → Local SQLite Buffer**

Permanent server events:

- Start
- Reached
- End

---

#### 33. Current Location Snapshot

Showroom Manager opens active test drive.

Button:

**Get Current Location**

Backend requests location from consultant app.

Current point is returned.

Low-frequency refresh can remain active while manager is viewing.

Target:

approximately **10-minute refresh cadence** for normal monitoring.

---

#### 34. Real-Time Boost

Button:

**Real-Time Boost — 1 Minute**

For one minute:

Sales Consultant app sends near-real-time location.

Target:

approximately every **5–10 seconds**, depending on OS/network.

Use:

**Supabase Realtime Broadcast**

Do not insert every live ping into PostgreSQL.

After 1 minute:

**Automatically stop.**

---

#### 35. Tracking Usage Credits

Keep tracking credit separate from AI credit.

Example:

- Snapshot → no credit
- Normal low-frequency view → low/no charge
- 1-minute Real-Time Boost → optional tracking credit

Super Admin controls this billing configuration.

---

#### 36. Tracking Failure

If device cannot respond:

show:

**Live Location Unavailable**

Also show:

- Last Known Location
- Last Updated Time

Never call stale data live.

---

#### 37. Quotations

Showroom Manager monitors quotations across teams.

###### KPI

- Total
- Sent
- Revised
- Approval Pending
- Approved
- Expiring Soon

###### Filters

- Branch
- Team
- Sales Consultant
- Customer
- Model
- Status
- Date

###### Table

- Quote ID
- Customer
- Sales Consultant
- Team
- Model
- Variant
- On-Road Price
- Discount
- Created
- Last Sent
- Status
- Approval Status
- Action

Default:

**Read-only**

---

#### 38. Quotation Approval

If permission is granted:

```
quotation.approve_discount
```

Show:

- Approve
- Reject
- Return for Revision

Showroom Manager can act only within configured authority.

Example:

Up to ₹20,000 discount approval.

Above that:

escalate to GM or higher configured approver.

Pricing master itself remains controlled by authorized pricing/admin roles.

---

#### 39. Bookings

###### KPI

- Pending
- Confirmed
- Stock Awaited
- Vehicle Allocated
- Ready for Delivery
- Delivered
- Cancelled

###### Table

- Booking ID
- Customer
- Sales Consultant
- Team
- Model
- Variant
- Colour
- Booking Amount
- Booking Date
- Payment Status
- Stock Status
- Finance Status
- Insurance Status
- RTO Status
- Delivery Status
- Expected Delivery
- Booking Status
- Action

---

#### 40. Booking Actions

Default Showroom Manager:

- View
- Open Customer
- Add Manager Note
- View history
- Escalate issue

Does not automatically perform:

- Finance processing
- Insurance processing
- RTO processing
- Inventory allocation
- Delivery processing

Those belong to operational departments.

---

#### 41. Approvals

This is an important Showroom Manager page.

Tabs:

- Pending
- Approved
- Rejected
- Returned
- Escalated

###### Approval Types

Permission/configuration based:

- Quotation Discount
- Booking Override
- Booking Cancellation
- Lead Transfer Override
- Exchange Approval
- Test Drive Exception
- Other Configured Approval

###### Table

- Approval ID
- Type
- Customer
- Requested By
- Team
- Amount / Variance
- Reason
- Submitted At
- SLA
- Status
- Action

---

#### 42. Approval Detail

Use **shadcn Sheet**.

Show:

- Customer
- Related Lead/Booking/Quotation
- Requestor
- Current values
- Requested change
- Reason
- Supporting notes
- History
- Approval authority

Actions:

- Approve
- Reject
- Return for Revision
- Escalate

Every action audited.

---

#### 43. Sales Teams

This replaces any old Team Leader concept.

Structure:

**Team Manager → Telecallers + Sales Consultants**

###### Team Card/Table

- Team Name
- Team Manager
- Telecallers
- Sales Consultants
- Active Leads
- Pending Leads
- Follow-ups Due
- Test Drives
- Quotations
- Bookings
- Conversion
- Target %

Click team:

open team detail.

---

#### 44. Team Detail

Show:

###### Team Manager

- Name
- Status
- Scope
- Target
- Achievement

###### Telecallers

- Active Leads
- Calls
- Qualified Leads
- Follow-up Compliance

###### Sales Consultants

- Active Leads
- Test Drives
- Quotations
- Bookings
- Conversion

---

#### 45. Team Composition

Showroom Manager can move existing users between permitted teams when permission allows.

Example:

**Move Sales Consultant A**
from Team 1 → Team 2

Every move audited.

Creating a completely new user is separate and requires **Users** permission.

---

#### 46. Showroom Targets

Hierarchy:

**GM → Showroom Target → Showroom Manager → Team Targets**

GM gives target to Showroom Manager's scope.

Showroom Manager distributes that target across Team Managers.

Example:

GM target:

**100 bookings/month**

Showroom Manager allocates:

- Team A → 35
- Team B → 35
- Team C → 30

---

#### 47. Target Page

###### KPI

- Overall Target
- Achieved
- Remaining
- Achievement %
- Days Remaining

###### Team Target Table

- Team
- Team Manager
- Assigned Target
- Achieved
- Remaining
- Achievement %
- Forecast
- Status

###### Apache ECharts Bar

**Target vs Actual by Team**

###### Apache ECharts Line

**Daily/Weekly Achievement Trend**

---

#### 48. Target Rules

Showroom Manager can allocate targets within the target assigned by GM.

Do not silently allow distributed team targets to exceed showroom target.

If over-allocation is allowed later, require explicit permission.

---

#### 49. Performance

Showroom Manager sees:

- Team Manager performance
- Telecaller performance
- Sales Consultant performance
- Team totals
- Showroom totals

###### KPI

- Leads Contacted
- Qualified
- Test Drives
- Quotations
- Bookings
- Conversion
- Target Achievement
- Follow-up Compliance

---

#### 50. Performance Filters

- Branch
- Team
- Team Manager
- Role
- User
- Date Range
- Model
- Source

---

#### 51. Performance Charts

###### Apache ECharts Funnel

**Assigned → Contacted → Qualified → Test Drive → Quotation → Booking**

###### Apache ECharts Line

- Qualified
- Test Drives
- Quotations
- Bookings

###### Apache ECharts Bar

Compare:

- Teams
- Team Managers
- Consultants
- Telecallers

depending on selected view.

---

#### 52. Performance Table

Columns:

- User
- Role
- Team
- Assigned Leads
- Calls
- Connected
- Qualified
- Follow-ups Completed
- Test Drives
- Quotations
- Bookings
- Conversion %
- Target %
- SLA Compliance

Click user:

**Performance Detail**

---

#### 53. Lost Leads

Showroom Manager sees lost leads across all permitted teams.

###### KPI

- Lost This Month
- Recoverable
- High-value Lost
- Recovery %
- Competitor Losses

###### Filters

- Branch
- Team
- User
- Source
- Model
- Loss Reason
- Competitor
- Date

###### Table

- Lead ID
- Customer
- Owner
- Team
- Source
- Model
- Lost Date
- Loss Reason
- Competitor
- Last Note
- Recovery Score
- Action

Actions:

- Open
- Reopen
- Assign Recovery Owner
- Move to another team
- Add Manager Note

---

#### 54. Lost Lead Analytics

Use **Apache ECharts Donut**:

Loss Reasons.

Use **Apache ECharts Bar**:

Competitor-wise Lost Leads.

---

#### 55. Escalations

Showroom Manager handles escalations coming from Team Managers.

Tabs:

- New
- In Progress
- Resolved
- Escalated to GM

###### KPI

- New
- In Progress
- SLA Risk
- Resolved Today

###### Table

- Escalation ID
- Customer
- Lead
- Team Manager
- Responsible User
- Issue
- Priority
- SLA
- Created
- Status
- Action

Actions:

- Assign
- Comment
- Resolve
- Escalate to GM

---

#### 56. Reports

Showroom Manager gets scope-based reports.

Reports:

- Lead Funnel
- Lead Source Performance
- Model Performance
- Team Manager Performance
- Telecaller Performance
- Sales Consultant Performance
- Follow-up Compliance
- Call Performance
- Test Drive Performance
- Quotation Conversion
- Booking Conversion
- Target Achievement
- Lost Lead Analysis
- SLA Performance

Filters:

- Date
- Branch
- Team
- User
- Role
- Source
- Model

---

#### 57. Optional Users Page

Show this sidebar item only when Client Admin enables:

**User Management**

Showroom Manager may then:

- Create allowed users
- Edit allowed users
- Disable allowed users
- Assign branch scope
- Assign team
- Assign permitted role

---

#### 58. Allowed User Creation

Default allowed examples:

- Team Manager
- Sales Consultant
- Telecaller/BDC
- Finance User
- Insurance User
- RTO User
- Inventory User
- Exchange User
- Delivery User
- Customer Relationship User

Not allowed by default:

- System Administrator
- Client Admin
- Business Owner
- Super Admin

---

#### 59. User Permission Ceiling

Showroom Manager can never create a user with:

- broader branch scope than themselves
- higher delegated authority than allowed
- unauthorized role
- unauthorized department access

Example:

Showroom Manager has:

**Branches: A + B**

They can create:

**Finance User: Branch A**

or:

**Sales Consultant: Branch A + B**

They cannot create:

**User: ALL\_BRANCHES**

because that exceeds their own scope.

---

#### 60. Operational Department Access

Operational modules are not part of default Showroom Manager sidebar.

Default Showroom Manager can see status of:

- Finance
- Insurance
- RTO
- Inventory
- Exchange
- Delivery

through:

**Customer 360 + Booking**

If Client Admin grants operational permission, those modules can appear dynamically.

Example:

`inventory.view` → Inventory page appears.

`finance.view` → Finance page appears.

`inventory.allocate` → allocation action appears.

Role remains Showroom Manager.

We do not create duplicate roles.

---

#### 61. Customer 360

Showroom Manager can open Customer 360 for customers within authorized scope.

Sections:

- Customer Profile
- Leads
- Calls
- Conversations
- Follow-ups
- Appointments
- Test Drives
- Quotations
- Bookings
- Vehicles
- Exchange
- Finance
- Insurance
- RTO
- Inventory Allocation
- Delivery
- Documents
- Timeline

Customer remains the central source of truth.

---

#### 62. Common Customer Link

Operational records link back using:

**customer\_id**

plus their own department record IDs.

Example:

**Customer → Booking → Finance / Insurance / RTO / Vehicle / Delivery**

One customer can have multiple purchases over time.

---

#### 63. Table Technology

All major tables use:

**shadcn Table + TanStack Table**

No custom data-grid framework unless required later.

---

#### 64. Server-Side Pagination

Default:

**25 rows**

Options:

**25 / 50 / 100**

Do not download thousands of rows and paginate in browser.

---

#### 65. Page-Local Search

Search only inside the current page/resource.

Example:

Showroom Leads search finds:

- Lead ID
- Customer Name
- Phone

It should not globally search bookings, quotations and calls.

---

#### 66. Search Debounce

Use approximately:

**300ms**

Flow:

**Typing → wait 300ms → cancel stale request → execute latest indexed query**

---

#### 67. Database Search

Use B-tree indexes for:

- tenant
- branch
- team
- assigned user
- status
- dates
- phone

For fuzzy customer name:

**PostgreSQL** **`pg_trgm`** **+ GIN index**

Do not use trigram indexes everywhere.

---

#### 68. Sorting

Server-side sorting only.

Allowed columns can include:

- Created At
- Customer
- Follow-up Date
- Priority
- Lead Age
- Booking Date
- Call Date
- Status

Frontend sends predefined sort keys only.

---

#### 69. Virtualization

Use **TanStack Virtual** only where useful:

- 100-row dense views
- Very long activity timeline
- Long transcript lists
- Large user selectors

Normal 25-row tables do not need virtualization.

---

#### 70. TanStack Query

Use for all server state.

Same CRM rule:

```
staleTime = 60 sec
gcTime = 30 min
refetchOnWindowFocus = false
refetchOnReconnect = true
```

Manual refresh:

**Maximum 3/minute/user/page-resource**

---

#### 71. Zustand

Use only for:

- sidebar state
- temporary filters
- modal state
- selected rows
- UI context

Do not use Zustand as server cache.

---

#### 72. IndexedDB

Persist selected non-sensitive web query data.

Never persist:

- provider credentials
- MFA secrets
- sensitive auth data
- recordings
- full transcripts

---

#### 73. Lazy Loading

Load heavy features only when opened.

Examples:

- Map SDK → Test Drive Map only
- Call recording URL → when Play pressed
- Transcript → Call Detail
- Customer Timeline → Customer 360
- ECharts → analytics page
- Large export → background job

---

#### 74. Trigger.dev

Use for:

- IVR sync
- Call recording ingestion
- Provider retries
- AI transcription
- AI summary
- Large reports
- Exports
- SLA background jobs

Do not use it for live GPS streaming.

---

#### 75. RLS Security

Every query requires:

**Tenant + User Permission + Data Scope**

Frontend visibility alone is never considered security.

Supabase RLS enforces access.

---

#### 76. Final Showroom Manager Permission Summary

| **Capability**                    | **Showroom Manager**          |
| --------------------------------- | ----------------------------- |
| View all permitted showroom leads | ✅                             |
| View all teams in scope           | ✅                             |
| Assign/reassign leads             | ✅                             |
| Override team assignment mode     | ✅                             |
| View Telecaller performance       | ✅                             |
| View Sales Consultant performance | ✅                             |
| View Team Manager performance     | ✅                             |
| View team calls                   | ✅                             |
| Listen to recordings              | ✅ permission based            |
| Sync IVR call                     | ✅                             |
| View follow-ups                   | ✅                             |
| View appointments                 | ✅                             |
| Reassign consultant               | ✅                             |
| View test drives                  | ✅                             |
| Request GPS snapshot              | ✅                             |
| 1-minute real-time tracking       | ✅ permission based            |
| View quotations                   | ✅                             |
| Approve discounts                 | ✅ within configured authority |
| Edit pricing master               | ❌                             |
| View bookings                     | ✅                             |
| Process Finance/RTO/Insurance     | ❌ by default                  |
| Edit Inventory                    | ❌ by default                  |
| View operational statuses         | ✅                             |
| Operational module access         | Optional permission           |
| Manage Sales Teams                | ✅                             |
| Allocate targets to teams         | ✅                             |
| View lost leads                   | ✅                             |
| Reopen/reassign lost leads        | ✅                             |
| Handle escalations                | ✅                             |
| Escalate to GM                    | ✅                             |
| Reports                           | ✅ scope based                 |
| Create users                      | Optional permission           |
| Create System Administrator       | ❌ by default                  |
| Create Client Admin               | ❌                             |
| Create Business Owner             | ❌                             |
| Create Super Admin                | ❌                             |

---

#### 77. Final Showroom Manager Flow

**GM assigns showroom target**

↓

**Showroom Manager**

↓

**Team Managers**

↓

**Telecaller / Sales Consultant**

↓

**Lead Assignment**

↓

**Contact**

↓

**Qualified**

↓

**Appointment**

↓

**Test Drive**

↓

**Quotation**

↓

**Approval if required**

↓

**Booking**

↓

**Operational Departments**

↓

**Finance / Insurance / RTO / Inventory / Exchange / Delivery**

Throughout that flow, Showroom Manager supervises the showroom, manages teams, handles approvals/escalations, monitors targets/performance, and coordinates operational status without automatically taking over specialist department workflows.

This is the version I would treat as the **frozen Showroom Manager PRD**.


### 54.5 GM Sales Executive — detailed page PRD

#### GM Sales Executive — What Each Page Should Do

##### 1. Dashboard

Yes — same professional dashboard pattern we used before, but at **GM scope**.

If GM has 3 branches, every KPI/chart aggregates those 3 branches. If `ALL_BRANCHES`, it aggregates the whole dealership.

###### KPI cards

- Total Active Leads
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Lost Leads
- Sales Conversion %
- Target Achievement %
- Revenue / Booking Value
- Pending GM Approvals

###### Charts

**Apache ECharts Funnel**

```
Leads → Contacted → Qualified → Test Drive → Quotation → Booking
```

**Apache ECharts Line**

- Leads
- Test Drives
- Quotations
- Bookings

over time.

**Apache ECharts Bar**

```
Showroom-wise Target vs Actual
```

###### Requires Attention

Examples:

- Showroom below target
- High lost-lead %
- Approval pending with GM
- Booking stuck in operations
- High SLA-risk branch
- Excessive quotation-to-booking drop

Everything clickable to the relevant filtered page.

---

#### 2. Sales Leads

Here I would make one correction.

GM should **not work leads** and should not modify customer requirements/status normally.

But GM should be able to **view the complete sales pipeline within their authorized branches**, not only Test Drive leads.

Otherwise GM cannot understand why one showroom has poor conversion.

###### GM sees

- Qualified
- Appointment
- Test Drive
- Quotation
- Booking
- Lost

We can hide very early raw/unassigned leads by default because those are Team Manager/Showroom Manager operational work.

So GM's **Sales Leads** page starts mainly from **Qualified Sales Opportunities onward**.

###### Table

- Lead ID
- Customer
- Branch
- Team
- Sales Consultant
- Interested Model
- Temperature
- Sales Stage
- Test Drive Status
- Quotation Status
- Booking Status
- Last Activity
- Action

Default permission:

**Read-only**

Clicking customer opens **Customer 360**.

And yes, Customer 360 must contain the complete timeline:

```
Lead Created → Calls → Qualification → Assignment → Appointment → Test Drive → Quotation → Booking → Finance → Insurance → RTO → Vehicle Allocation → Delivery
```

So the GM can understand exactly what happened to that customer without changing the record.

---

#### 3. Showroom Comparison

Yes.

This compares **all showrooms within that GM's scope**.

Example:

| **Showroom** | **Leads** | **Qualified** | **Test Drives** | **Quotations** | **Bookings** | **Conversion** | **Target** |
| ------------ | --------- | ------------- | --------------- | -------------- | ------------ | -------------- | ---------- |
| MG Road      | 420       | 190           | 105             | 83             | 42           | 10%            | 84%        |
| Whitefield   | 390       | 178           | 121             | 94             | 51           | 13%            | 102%       |

Charts:

- Bookings by Showroom
- Conversion by Showroom
- Target vs Actual
- Lost Lead %
- Test Drive → Booking %

Click showroom → **Showroom Detail**.

---

#### 4. Sales Performance

Yes — overall sales performance for **all showrooms assigned to the GM**.

Show:

- Total Leads
- Qualified
- Test Drives
- Quotations
- Bookings
- Conversion
- Target Achievement
- Lost %
- Average Sales Cycle

GM can drill:

**Overall → Showroom → Team → Sales Consultant**

but doesn't edit their daily activities.

---

#### 5. Consultant Ranking

Yes — this should specifically mean **Sales Consultant Ranking**.

I would rename sidebar to:

###### Sales Consultant Ranking

Much clearer.

Ranking metrics can include:

- Bookings
- Conversion %
- Test Drives
- Quotations
- Quote → Booking %
- Target Achievement
- Lost Leads
- Customer Follow-up Compliance

Example:

```
#1 Rahul — 18 bookings — 126% target
#2 Sneha — 16 bookings — 112% target
```

We should **not mix Telecallers into this ranking**.

Telecaller performance is different and can be available through Reports/Performance drill-down.

---

#### 6. Lead Source Performance

Exactly.

Shows where leads came from and what happened to them.

Sources:

- Facebook
- Instagram
- Google Ads
- Website
- WhatsApp
- CarWale
- CarDekho
- Justdial
- IndiaMART
- Manual
- etc.

For each:

| **Source** | **Leads** | **Qualified** | **Test Drives** | **Quotations** | **Bookings** | **Lost** | **Conversion** |
| ---------- | --------- | ------------- | --------------- | -------------- | ------------ | -------- | -------------- |

This lets the GM answer:

> Facebook gives 500 leads, but does it actually generate bookings?

###### Useful charts

**ECharts Bar:** Leads vs Bookings by Source

**ECharts Funnel:** selected source conversion

**ECharts Donut:** lead share by source

If campaign data exists, GM can drill:

```
Facebook → Campaign → Leads → Bookings
```

---

#### 7. Model Performance

Yes — vehicle-model performance.

But don't base it only on Inventory.

Combine actual customer activity:

- Customer Interest
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Lost Leads

Example:

| **Model** | **Interested** | **Test Drives** | **Quotes** | **Bookings** | **Stock** | **Conversion** |
| --------- | -------------- | --------------- | ---------- | ------------ | --------- | -------------- |
| Elevate   | 420            | 180             | 145        | 79           | 12        | 18.8%          |
| City      | 310            | 121             | 100        | 61           | 5         | 19.7%          |

###### Inventory integration

Yes, stock information can be joined read-only:

- Available Qty
- Reserved
- Incoming
- Expected Arrival

So GM can understand situations like:

> Elevate has very strong demand but only 2 units available.

GM does **not edit inventory here**.

Inventory Department remains the source of truth for vehicle stock.

---

#### 8. Targets

This is useful because **GM is the person who receives/controls higher-level sales targets and distributes them to showrooms**.

Example:

Dealer monthly target:

**300 vehicles**

GM has 3 showrooms.

GM allocates:

```
MG Road → 100
Whitefield → 110
Koramangala → 90
```

Then Showroom Manager divides their 100 among Team Managers.

###### Target types

Don't make arbitrary unlimited target creation.

Client Admin configures available target metrics such as:

- Bookings
- Deliveries
- Test Drives
- Quotations
- Lead Qualification
- Revenue / Booking Value

GM chooses:

- Target Period
- Target Metric
- Branch/Showroom
- Target Value

Example:

**September 2026**
**Bookings**
**Whitefield**
**110**

###### Target page

Show:

- Assigned Target
- Achieved
- Remaining
- Forecast
- Achievement %
- Days Remaining

And:

**Target vs Actual by Showroom**

---

#### 9. Approvals

This means requests that **cannot be approved by Showroom Manager because they exceed that manager's authority**.

Example:

Sales Consultant wants:

**₹50,000 discount**

Showroom Manager authority:

**up to ₹25,000**

So:

```
Sales Consultant → Showroom Manager → exceeds limit → GM Approval
```

Other possible GM approvals:

- High-value discount
- Exceptional quotation
- Major booking cancellation/refund request
- Exchange exception
- Cross-showroom lead/vehicle exception
- Target adjustment
- Exceptional sales override

The exact approval types are configurable.

###### GM actions

- Approve
- Reject
- Return for Revision
- Add Note

Everything audited.

---

#### 10. Bookings Overview

This is important, and **booking does not mean everything is finished**.

Booking is where the customer has moved from opportunity into an actual purchase workflow.

###### Correct flow

```
Lead
```

→ `Qualified`

→ `Sales Consultant`

→ `Showroom Visit / Test Drive`

→ `Quotation`

→ `Customer Accepts`

→ **Booking**

Then the operational workflow begins:

```
Booking
```

→ `Vehicle Allocation / Inventory`

→ `Finance if required`

→ `Insurance`

→ `RTO`

→ `Pre-Delivery / Delivery`

→ **Delivered**

###### Who owns what?

**Sales Consultant**
remains the customer-facing sales owner.

They can see all statuses and communicate with the customer.

But they don't perform every backend operation.

**Inventory**

- Vehicle allocation
- VIN/chassis
- Stock reservation

**Finance**

- Loan application
- Bank status
- Approval
- Disbursement

**Insurance**

- Policy
- Premium
- Policy issuance

**RTO**

- Registration workflow
- Required registration documentation
- Registration number/status

**Delivery**

- Readiness
- Checklist
- Scheduling
- Vehicle handover

###### Showroom Manager

Monitors all of these for the showroom and resolves/escalates delays.

###### GM

Gets a higher-level booking overview across their branches.

---

#### 11. Booking Overview Table

GM should see:

- Booking ID
- Customer
- Branch
- Sales Consultant
- Vehicle
- Booking Date
- Booking Amount
- Vehicle Allocation
- Finance
- Insurance
- RTO
- Delivery
- Expected Delivery
- Overall Status
- Delay / SLA
- Action

Example:

**BK-1042 | Ravi | Whitefield | Elevate**

```
Inventory ✅
Finance ✅
Insurance ✅
RTO ⏳
Delivery Pending
```

GM immediately knows the customer is waiting at **RTO**.

Clicking opens Booking Detail and Customer Timeline.

---

#### 12. Legal / Compliance Handling

For RTO, finance, insurance and delivery, don't hard-code assumptions that one process is legally identical everywhere.

CRM should support:

- mandatory document checklist
- required approval stages
- timestamps
- document history
- user audit trail
- cannot mark required stage complete without required data
- dealership/state-specific configuration

For example, RTO requirements can differ by jurisdiction and process.

So **authorized Admin/Operational configuration defines required workflow**, while the CRM enforces that configured workflow.

This is much safer than putting legal rules directly into Sales Consultant code.

---

#### 13. Lost Leads

Yes.

GM sees Lost Leads across **all branches within their own scope**.

Sources include:

- Telecaller lost
- Sales Consultant lost
- Customer not interested
- Competitor chosen
- Price
- Finance issue
- Stock issue
- No response
- Delivery timeline
- Other configured reason

###### GM mainly analyzes

- Why are we losing customers?
- Which showroom loses most?
- Which model?
- Which source?
- Which competitor?
- Which consultant/team?
- Can some leads be recovered?

GM can drill into Customer 360 read-only.

Recovery assignment can generally go back through Showroom Manager.

---

#### 14. Escalations

Yes — exactly.

Hierarchy:

```
Telecaller / Sales Consultant
```

→ `Team Manager`

→ `Showroom Manager`

→ **GM**

If Showroom Manager cannot solve it or the issue exceeds their authority, they escalate it to GM.

Examples:

- Major customer complaint
- High-value discount
- Cross-showroom stock issue
- Repeated SLA failure
- Booking stuck unusually long
- Serious process issue
- Manager-level conflict

GM can:

- Resolve
- Comment
- Send Back
- Reassign
- Escalate further if a higher authority exists

---

#### 15. Reports

GM reports should be strategic and multi-showroom.

Include:

- Overall Sales Funnel
- Showroom Performance
- Team Performance
- Sales Consultant Performance
- Telecaller Performance
- Lead Source Performance
- Model Performance
- Test Drive Conversion
- Quotation Conversion
- Booking Conversion
- Lost Lead Analysis
- Target Achievement
- SLA Performance
- Operational Booking Delays

Filters:

```
Date | Branch | Showroom | Team | User | Model | Source
```

Heavy exports can run through Trigger.dev.

---

#### Final GM Sidebar — Small Naming Improvement

I would now freeze it as:

1. **Dashboard**
2. **Sales Leads**
3. **Showroom Comparison**
4. **Sales Performance**
5. **Sales Consultant Ranking**
6. **Lead Source Performance**
7. **Model Performance**
8. **Targets**
9. **Approvals**
10. **Bookings Overview**
11. **Lost Leads**
12. **Escalations**
13. **Reports**

Optional:

**Users** — only if delegated user-management permission is enabled.

This makes GM clearly different from Showroom Manager:

**Team Manager = manages team operations**

**Showroom Manager = manages showroom operations**

**GM = manages multiple/showroom-level sales performance, targets, approvals and strategic issues**

And yes, every customer continues using the **same Customer UUID**, so the GM can open one Customer 360 and see the complete lead-to-delivery timeline across Sales + Inventory + Finance + Insurance + RTO + Delivery.


### 54.6 Client Admin — detailed page PRD

##### CLIENT ADMIN — FINAL WEB PRD

##### 1. Role Purpose

Client Admin is the **main dealership-level configuration and administration authority**.

Client Admin controls:

- Branches
- Teams
- Users
- Roles
- Permissions
- Data Scope
- Lead routing
- Assignment rules
- CRM configuration
- Custom fields
- Integrations
- Operational modules
- Targets
- Approval limits
- AI usage
- Security/audit
- Administrative reports

Client Admin does **not need to perform daily Telecaller/Sales Consultant work**.

Current MVP:

**Client Admin = Web only**

---

#### 2. Core Security Architecture

Everything follows:

**USER → ROLE → PERMISSIONS → DATA SCOPE**

Role defines:

**What can this user do?**

Data Scope defines:

**Where can this user do it?**

Supported scope modes:

-

```
ONE_BRANCH
```

1.

```
SELECTED_BRANCHES
```

1.

```
ALL_BRANCHES
```

Important UI rule:

If:

**ALL\_BRANCHES**

is selected:

- branch picker becomes disabled
- previously selected branches are cleared

If:

**ONE\_BRANCH / SELECTED\_BRANCHES**

is selected:

- ALL\_BRANCHES cannot simultaneously be selected

---

#### 3. What Client Admin Can Create

Client Admin can create/configure users such as:

- GM Sales Executive
- Showroom Manager
- Team Manager
- Sales Consultant
- Telecaller / BDC
- System Administrator
- Finance Users
- Insurance Users
- RTO Users
- Inventory Users
- Used Car / Exchange Users
- Delivery Users
- Customer Relationship Users
- Digital Marketing Users
- Other configured operational roles

Client Admin can also assign:

- Role
- Permissions
- Branch scope
- Team
- Department
- MFA requirement
- Operational module access

---

#### 4. Final Client Admin Sidebar

1. **Dashboard**
2. **Branches**
3. **Teams**
4. **Users**
5. **Roles & Permissions**
6. **Lead & Assignment Settings**
7. **CRM Configuration**
8. **Custom Fields**
9. **Integrations**
10. **Modules & Access**
11. **Targets & Approval Rules**
12. **AI & Usage**
13. **Audit Logs**
14. **Reports**

Contextual pages, not sidebar:

- User Detail
- Branch Detail
- Team Detail
- Role Detail
- Permission Detail
- Integration Detail
- Field Mapping
- Module Configuration
- Approval Rule Detail
- Audit Event Detail

---

#### 5. Shared Web Technology

Use:

**Next.js + TypeScript + Tailwind + shadcn/ui**

Use shadcn primitives wherever possible:

- Sidebar
- Card
- Button
- Badge
- Table
- Tabs
- Input
- Select
- Command
- Popover
- Calendar
- Dialog
- AlertDialog
- Sheet
- DropdownMenu
- Tooltip
- Avatar
- Checkbox
- RadioGroup
- Switch
- Textarea
- Progress
- Separator
- Accordion
- ScrollArea
- Skeleton
- Form

Do not create another separate design system.

---

#### 6. Charts

Use:

**Apache ECharts only**

No:

- Recharts
- Chart.js
- ApexCharts

Use ECharts only where analytics adds value.

Configuration pages do not need unnecessary charts.

---

#### 7. Dashboard

Purpose:

> Give Client Admin an immediate view of dealership configuration, system health, usage and important administrative issues.

###### KPI Cards

Use `shadcn Card`.

Show:

- Total Branches
- Active Branches
- Total Users
- Active Users
- Sales Users
- Operational Users
- Leads Today
- Bookings This Month
- Integrations Connected
- Integration Issues
- AI Credits Remaining
- Pending Admin Issues

---

#### 8. Dashboard — User Distribution

Use **Apache ECharts Donut**.

Segments:

- Telecaller
- Sales Consultant
- Team Manager
- Showroom Manager
- GM
- Operational Users
- System Admin

This tells Client Admin how the organization is structured.

---

#### 9. Dashboard — Activity Trend

Use **Apache ECharts Line**.

Metrics:

- Active Users
- Leads Created
- Bookings
- Integration Events

Selectable:

- 7 Days
- 30 Days
- Custom Range

---

#### 10. Dashboard — Branch Overview

Use **Apache ECharts Bar**.

Compare:

- Users per Branch
- Leads per Branch
- Bookings per Branch

This is administrative visibility, not a replacement for GM Sales analytics.

---

#### 11. Dashboard — Requires Attention

Cards/list:

- Integration Failed
- User Locked
- Branch Configuration Incomplete
- AI Credits Low
- Lead Mapping Error
- Assignment Queue Problem
- MFA Not Enabled for Required User
- Provider Credential Expiring
- Module Configuration Missing

Clicking opens the correct admin page.

---

#### 12. Branches

Client Admin creates and manages dealership branches.

###### Header

**Branches**

Action:

**+ Add Branch**

###### KPI

- Total Branches
- Active
- Inactive
- Users Assigned

No chart necessary.

---

#### 13. Branch Table

Columns:

- Branch Name
- Branch Code
- City
- Address
- Contact Number
- Manager
- Teams
- Users
- Status
- Created
- Action

Actions:

- Open
- Edit
- Disable
- View Users

Use:

**shadcn Table + TanStack Table**

---

#### 14. Create/Edit Branch

Use `shadcn Dialog` or full contextual page.

Fields:

- Branch Name
- Branch Code
- Address
- City
- State
- PIN
- Phone
- Email
- Working Hours
- Timezone if needed
- Status

Optional:

- Geo coordinates
- Showroom category
- Default team
- Default integration mapping

---

#### 15. Teams

Final hierarchy:

**Team Manager → Telecaller/BDC + Sales Consultant**

There is no Team Leader.

###### KPI

- Total Teams
- Active Teams
- Telecallers
- Sales Consultants

---

#### 16. Team Table

Columns:

- Team Name
- Branch
- Team Manager
- Telecallers
- Sales Consultants
- Assignment Mode
- Active Leads
- Status
- Action

Actions:

- Open
- Edit
- Move Users
- Configure Assignment
- Disable

---

#### 17. Team Detail

Show:

###### Team Information

- Name
- Branch
- Manager
- Status

###### Members

Telecallers and Sales Consultants.

###### Assignment Settings

Fresh Leads:

- Round Robin
- Manual

Qualified Leads:

- Round Robin
- Manual

###### Workload

- Active Leads
- Pending Leads
- Follow-ups Due
- Qualified Awaiting Sales

---

#### 18. Users

This is one of the most important Client Admin pages.

###### KPI

- Total Users
- Active
- Inactive
- MFA Required
- MFA Enabled
- Locked Accounts

###### Filters

- Search
- Role
- Department
- Branch
- Team
- Scope Type
- Status
- MFA Status

---

#### 19. Users Table

Columns:

- User
- Email
- Phone
- Role
- Department
- Scope
- Branches
- Team
- MFA
- Last Login
- Status
- Action

Actions:

- Open
- Edit
- Disable
- Reset Access
- Change Role
- Change Scope
- Reset MFA where policy permits

---

#### 20. Create User

Use multi-step `shadcn Dialog/Sheet`.

###### Step 1 — Identity

- Full Name
- Email
- Phone
- Employee ID
- Department

###### Step 2 — Role

Select:

- GM
- Showroom Manager
- Team Manager
- Sales Consultant
- Telecaller
- System Administrator
- Operational Role
- Custom Role

###### Step 3 — Data Scope

Choose exactly one:

**ONE\_BRANCH**

or

**SELECTED\_BRANCHES**

or

**ALL\_BRANCHES**

###### Step 4 — Team

If relevant:

- Team assignment
- Reporting manager

###### Step 5 — Security

- MFA Required
- Force Password Change
- Account Status

###### Step 6 — Review

Show complete permission/scope summary before creation.

---

#### 21. System Administrator Creation

Client Admin can create System Administrators.

System Administrator may have:

**ONE\_BRANCH**

**SELECTED\_BRANCHES**

or

**ALL\_BRANCHES**

Example:

System Admin A:

**MG Road only**

System Admin B:

**MG Road + Whitefield**

System Admin C:

**All Branches**

System Administrator authority is still controlled by granted permissions.

---

#### 22. GM Creation

Client Admin can create multiple GM users.

Each GM independently gets:

- Role
- Branch Scope
- Permissions
- Target scope
- Approval authority

Example:

GM A:

Branches 1, 2, 3

GM B:

Branches 4, 5, 6

or one GM can manage:

**ALL\_BRANCHES**

---

#### 23. Roles & Permissions

Keep:

**Role ≠ Data Scope**

Do not create roles like:

- GM Bangalore
- GM All Branches
- Finance Branch A

Instead:

**Role: GM**

-


**Scope: Selected Branches**

---

#### 24. Role List

Columns:

- Role Name
- Department
- Role Type
- Users Assigned
- Permissions Count
- Status
- Updated
- Action

Role Type:

- System
- Custom

Actions:

- View
- Edit Permissions
- Clone
- Disable custom role

---

#### 25. Permission Structure

Organize permissions by module.

Example:

###### Leads

-

```
lead.view
```

1.

```
lead.create
```

1.

```
lead.edit
```

1.

```
lead.assign
```

1.

```
lead.reassign
```

1.

```
lead.view_all_team
```

###### Calls

-

```
call.view
```

1.

```
call.recording.play
```

1.

```
call.sync
```

1.

```
call.ai_transcribe
```

###### Test Drive

-

```
test_drive.view
```

1.

```
test_drive.create
```

1.

```
test_drive.live_track
```

1.

```
test_drive.realtime_boost
```

###### Quotations

-

```
quotation.view
```

1.

```
quotation.create
```

1.

```
quotation.edit
```

1.

```
quotation.approve_discount
```

###### Users

-

```
users.view
```

1.

```
users.create
```

1.

```
users.edit
```

1.

```
users.disable
```

###### Operational

Separate permissions for:

- Finance
- Insurance
- RTO
- Inventory
- Exchange
- Delivery

---

#### 26. Roles & Permissions UI

Use:

-

```
shadcn Tabs
```

1.

```
Accordion
```

1.

```
Checkbox
```

1.

```
Switch
```

1.

```
Card
```

Example tabs:

**Sales | Operations | Administration | Integrations | AI | Reports**

Do not display 200 permissions as one giant list.

---

#### 27. Lead & Assignment Settings

This controls dealership-level routing.

###### Sections

- Lead Ingestion
- Fresh Lead Routing
- Qualification Rules
- Sales Assignment
- SLA Rules
- Assignment Eligibility

---

#### 28. Assignment Configuration

Per branch/team configure:

###### Fresh Leads

Default:

**Round Robin**

Alternative:

**Manual**

###### Qualified Leads

Default:

**Round Robin**

Alternative:

**Manual**

Team Manager can manage their team rules.

Showroom Manager can override within scope.

Client Admin has final configuration authority.

---

#### 29. Assignment Rule Table

Columns:

- Branch
- Team
- Lead Type
- Assignment Mode
- Eligible Role
- Eligible Users
- Fallback
- Status
- Updated By
- Action

---

#### 30. Lead Work-State Configuration

Keep lifecycle separate.

Configure:

###### New Today

Default:

**<24 hours and not contacted**

###### Pending

Default:

**≥24 hours and still not contacted**

###### SLA Risk

Configurable threshold.

Example:

- 2 hours
- 4 hours
- 8 hours
- custom

Do not automatically change lifecycle to Pending.

---

#### 31. CRM Configuration

This is the general business configuration page.

Use sections/tabs.

###### Lead Settings

- Lifecycle options
- Temperature
- Lost Reasons
- Lead Sources
- Qualification minimum fields

###### Call Settings

- Outcomes
- Recording settings
- Sync behavior

###### Follow-up Settings

- Reasons
- Priorities
- Reminder rules

###### Appointment Settings

- Showroom Visit
- Test Drive

###### Sales Settings

- Quotation workflow
- Booking workflow
- Customer matching rules

---

#### 32. Customer Matching Settings

Default matching signals:

- Normalized phone
- Email
- External identity

CRM shows:

**Possible Existing Customer**

User chooses:

- Link Existing Customer
- Create New Customer

Never auto-merge uncertain matches.

Customer UUID remains source of truth.

---

#### 33. Custom Fields

Client Admin creates dealership-specific fields without changing physical schema.

Supported entities:

- Customer
- Lead
- Booking
- Vehicle
- Exchange
- Other supported modules

---

#### 34. Field Types

- Text
- Number
- Date
- Yes/No
- Dropdown
- Multi-select

Configuration:

- Field Name
- Entity
- Type
- Required
- Options
- Help Text
- Visible Roles
- Editable Roles
- Status
- Display Order

---

#### 35. Custom Fields Table

Columns:

- Field
- Entity
- Type
- Required
- Visible To
- Editable By
- Status
- Order
- Action

Actions:

- Edit
- Disable
- Reorder

Avoid deleting fields containing historical values.

Prefer:

**Disable / Archive**

---

#### 36. Integrations

One central integration management page.

Supported categories:

###### Lead Sources

- Meta/Facebook
- Instagram
- Google Ads
- Website
- CarWale
- CarDekho
- Justdial
- IndiaMART

###### Communication

- WhatsApp Business
- IVR / Calling
- Email Provider

###### Other

- Maps
- AI Provider
- Voice AI
- future providers

---

#### 37. Integration Scope

Every connection can be configured for:

- ONE\_BRANCH
- SELECTED\_BRANCHES
- ALL\_BRANCHES

Example:

IVR Account A:

**Branch A**

Meta Account B:

**Branches A + B**

Website Integration C:

**All Branches**

---

#### 38. Integration Card

Use `shadcn Card`.

Show:

- Provider
- Connection Name
- Branch Scope
- Status
- Last Successful Sync
- Last Error
- Health
- Action

Badges:

- Connected
- Warning
- Failed
- Disabled

---

#### 39. Integration Detail

Sections:

- Credentials
- Scope
- Field Mapping
- Source Mapping
- Campaign Mapping
- Branch Mapping
- Test Connection
- Send Test Lead
- Sync History
- Error Logs

Provider secrets are never exposed after storage.

---

#### 40. Field Mapping

Example:

Provider sends:

```
full_name
```

CRM:

```
customer_name
```

Provider:

```
mobile
```

CRM:

```
phone
```

Flow:

**External → Mapping → Validation → Normalization → Canonical Lead**

UI:

Use shadcn:

- Select
- Table
- Badge
- Input
- Button

---

#### 41. Integration Health Chart

Use **Apache ECharts Line**.

Show:

- Successful Events
- Failed Events

over time.

Optional filter:

- Provider
- Branch
- Date

---

#### 42. Integration Error Table

Columns:

- Provider
- Connection
- Branch
- Event
- Error
- Date/Time
- Retry Status
- Action

Actions:

- View
- Retry
- Disable Connection

Background retries through Trigger.dev.

---

#### 43. Modules & Access

This controls which CRM departments/features are enabled for the dealership.

Available modules:

- Sales
- Finance
- Insurance
- RTO
- Inventory
- Used Car / Exchange
- Delivery
- Customer Relationship
- Digital Marketing

Future modules can be added.

---

#### 44. Module Card

Use `shadcn Card + Switch`.

Example:

**Finance**

Status:

Enabled

Users:

6

Branches:

All

Action:

**Configure Access**

---

#### 45. Module Access Configuration

Set:

- Enabled/Disabled
- Branch Scope
- Allowed Roles
- Users
- Read/Write capabilities

Example:

Showroom Manager:

```
finance.view = true
finance.process = false
```

This allows status visibility without finance processing authority.

---

#### 46. Targets & Approval Rules

This centralizes hierarchy authority.

###### Target Configuration

Available metrics:

- Leads
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Deliveries
- Revenue / Booking Value

Hierarchy:

**GM → Showroom Manager → Team Manager → Users**

---

#### 47. Target Rule Table

Columns:

- Target Type
- Period
- Assigned Role
- Branch Scope
- Distribution Allowed
- Status
- Action

---

#### 48. Approval Rules

Configure:

- Quotation Discount
- Booking Cancellation
- Exchange Exception
- Lead Transfer Override
- Test Drive Exception
- Other configured approval

Example:

Sales Consultant:

₹10,000

Showroom Manager:

₹25,000

GM:

₹50,000

Above GM:

configured higher authority.

---

#### 49. Approval Rule Editor

Use `shadcn Card + Table + Input`.

Fields:

- Approval Type
- Role
- Minimum
- Maximum
- Next Approver
- Branch Scope
- Active

Every change goes into Audit Logs.

---

#### 50. AI & Usage

Client Admin cannot necessarily allocate platform credits.

**Super Admin allocates dealership AI credits.**

Client Admin monitors and controls dealership usage according to permission.

###### KPI

- Credits Allocated
- Credits Used
- Credits Remaining
- Usage Today
- Usage This Month
- Active AI Users

---

#### 51. AI Usage Line Chart

Use **Apache ECharts Line**.

Series:

- Transcription
- Summary
- Field Extraction
- Other AI Usage

over time.

---

#### 52. AI Usage by Feature

Use **Apache ECharts Donut**.

Segments:

- Transcription
- Call Summary
- Field Extraction
- Image Generation
- Other AI

---

#### 53. AI Usage by User

Use **Apache ECharts Bar**.

Show top consuming users.

Table:

- User
- Role
- Branch
- Transcriptions
- Summaries
- Extraction
- Credits Used
- Last Used

---

#### 54. AI Feature Controls

Client Admin can enable/disable allowed dealership features.

Example:

- Call Transcription ✅
- AI Summary ✅
- Auto Field Suggestions ✅
- Image AI ❌

Cannot increase platform credit balance unless Super Admin grants that ability.

---

#### 55. Tracking Usage

Test-drive tracking should remain separate from AI credits.

Show optionally:

- Live Snapshots
- Real-Time Boost Sessions
- Tracking Usage
- Tracking Credits if enabled

Do not mix GPS credit and AI credit balances.

---

#### 56. Audit Logs

Critical admin page.

Track:

- User Created
- User Disabled
- Role Changed
- Scope Changed
- Permission Changed
- Branch Created
- Team Changed
- Assignment Rule Changed
- Lead Reassigned
- Integration Changed
- Module Enabled
- Approval Rule Changed
- Custom Field Changed
- AI Feature Changed
- Security Event

---

#### 57. Audit Table

Columns:

- Date/Time
- User
- Role
- Branch
- Module
- Action
- Resource
- Result
- IP/Session info where appropriate
- Action

Click opens contextual detail.

Audit events should be effectively immutable from normal Client Admin UI.

---

#### 58. Reports

Client Admin reports are administration/usage focused.

Include:

- User Activity
- Active Users
- Branch Usage
- Team/User Distribution
- Lead Integration Health
- Assignment Health
- AI Usage
- Module Usage
- Login/Security Activity
- Audit Export
- Integration Errors

Do not duplicate the GM's detailed strategic Sales Reports unnecessarily.

---

#### 59. Reports Charts

Depending on selected report:

Use:

###### ECharts Line

Activity over time.

###### ECharts Bar

Branch/user/module comparison.

###### ECharts Donut

Usage/status distribution.

Heavy report exports:

**Trigger.dev**

---

#### 60. Table Standard

Every large Client Admin table uses:

**TanStack Table + shadcn Table**

Server-side:

- Search
- Filtering
- Sorting
- Pagination

Never download the entire dealership dataset into the browser.

---

#### 61. Pagination

Default:

**25 rows**

Options:

- 25
- 50
- 100

Server-side pagination.

---

#### 62. Page-Local Search

Search is page-specific.

Example Users page searches:

- Name
- Email
- Phone
- Employee ID

It should not simultaneously search leads, bookings and customers.

---

#### 63. Debounce

Use approximately:

**300ms**

Flow:

**Type → wait → cancel old query → execute latest query**

TanStack Query handles current request/cache.

---

#### 64. Search Indexes

Use PostgreSQL indexes for:

- tenant\_id
- branch\_id
- team\_id
- user\_id
- role\_id
- status
- created\_at
- normalized\_phone
- email

Use PostgreSQL:

**pg\_trgm + GIN**

for fuzzy text search where useful:

- User Name
- Customer Name
- Branch Name

Do not put trigram indexes on everything.

---

#### 65. TanStack Virtual

Use only for genuinely long rendered lists such as:

- Permission matrices
- Very large audit result views
- Long user selection lists
- Large field mapping lists

Normal 25-row paginated tables don't require virtualization.

---

#### 66. TanStack Query

All server state.

Default CRM configuration:

```
staleTime = 60 seconds
gcTime = 30 minutes
refetchOnWindowFocus = false
refetchOnReconnect = true
```

Manual refresh:

**maximum 3/minute/user/page-resource**

---

#### 67. Zustand

Use only for:

- Sidebar state
- Modal state
- Temporary filters
- Wizard state
- Selected tabs
- Unsaved UI configuration

Do not use Zustand as server database cache.

---

#### 68. IndexedDB

Persist selected non-sensitive query data.

Do not persist:

- integration credentials
- auth tokens
- MFA secrets
- provider API secrets
- recordings
- full transcripts
- other highly sensitive content

---

#### 69. Lazy Loading

Important for Client Admin because many modules exist.

Load only when required:

- ECharts → analytics pages
- Integration logs → Integration Detail
- Permission matrix → Role Detail
- Audit detail → when opened
- Large report → on request
- Provider test tools → when integration opened

Do not load all modules on Dashboard.

---

#### 70. Provider Credential Security

Integration credentials stay server-side.

Do not store plaintext secrets in normal business tables.

Prefer encrypted/secure secret storage.

Frontend should normally show:

**••••••••**

with:

**Replace Credential**

not reveal stored secret.

---

#### 71. Trigger.dev

Use for:

- Integration retries
- Provider synchronization
- Test lead processing
- Large imports
- Call recording ingestion
- AI jobs
- Report generation
- Exports
- SLA checks
- Heavy scheduled jobs

---

#### 72. Supabase RLS

Client Admin remains tenant-isolated.

Every query must enforce:

**tenant\_id = current dealership**

plus permission/scope rules where applicable.

Client Admin A can never see Client B.

Frontend hiding is not security.

---

#### 73. MFA

MFA should be mandatory for Client Admin.

Use TOTP/app-based MFA.

Also mandatory for high-privilege users such as:

- System Administrator
- GM
- Business Owner
- Super Admin

according to our security policy.

---

#### 74. Client Admin User Management Ceiling

Client Admin has dealership-level authority but cannot touch platform-level Super Admin users.

Generally:

###### Can Manage

- dealership users
- operational roles
- sales roles
- System Administrator
- GM
- Showroom Managers
- Team Managers

###### Cannot Manage

- Super Admin

Business Owner remains a separate executive role.

Multiple Client Admin users can be supported where dealership policy allows it.

---

#### 75. System Administrator Relationship

System Administrator is delegated.

Example:

Client Admin creates:

**System Administrator — Ravi**

Scope:

**SELECTED\_BRANCHES**

Ravi gets:

- Branch A
- Branch B

Then the System Administrator only has the configured admin/technical capabilities within that scope.

System Admin does not automatically outrank Client Admin.

---

#### 76. Client Admin vs GM

###### Client Admin

Configures:

- users
- roles
- integrations
- modules
- workflows
- scopes
- system rules

###### GM

Runs:

- sales performance
- multi-showroom comparison
- targets
- higher approvals
- escalations

Do not mix those responsibilities unnecessarily.

---

#### 77. Client Admin vs Business Owner

Business Owner primarily sees executive business information.

Client Admin operates/configures the dealership CRM.

So:

**Business Owner = visibility**

**Client Admin = administration**

---

#### 78. Final Client Admin Flow

CLIENT ADMIN

     │

     ├── Creates Branches

     │

     ├── Creates Teams

     │

     ├── Creates Users

     │

     ├── Assigns Roles

     │

     ├── Assigns Permissions

     │

     ├── Assigns Data Scope

     │

     ├── Configures Lead Routing

     │

     ├── Configures CRM

     │

     ├── Creates Custom Fields

     │

     ├── Connects Integrations

     │

     ├── Enables Operational Modules

     │

     ├── Configures Targets

     │

     ├── Configures Approval Authority

     │

     ├── Monitors AI / Usage

     │

     ├── Reviews Audit Logs

     │

     └── Reviews Admin Reports



And from there:

CLIENT ADMIN

       ↓

GM / SYSTEM ADMIN / SHOWROOM MANAGER

       ↓

TEAM MANAGER

       ↓

TELECALLER + SALES CONSULTANT



AND



OPERATIONAL DEPARTMENT USERS



This is the **final Client Admin Web PRD** I would freeze. It also gives us the configuration foundation we need before designing **Finance, Insurance, RTO, Inventory, Exchange, Delivery and the other operational departments**.


### 54.7 Operational Departments — detailed page PRD

##### FINAL OPERATIONAL DEPARTMENTS PRD

Covered departments:

**Inventory → Finance → Insurance → RTO → Used Car / Exchange → Delivery → Customer Relationship → Digital Marketing**

This entire block follows one common rule:

> **Operational departments are workflow/queue based, not as complex as Telecaller/Sales.**

The UI should stay clean:

**Dashboard → Work Queue/List → Record Detail → Documents → Status Workflow → Reports**

Only add extra pages when the client enables them.

---

#### 1. COMMON OPERATIONAL ARCHITECTURE

Every customer-related operational record connects to the same master Customer 360.

Core linkage:

**`customer_id`** **→** **`booking_id`** **→ departmental case ID →** **`vehicle_id/VIN`** **where applicable**

Example:

Customer UUID

   ↓

Booking ID

   ├── Inventory Allocation ID

   ├── Finance Case ID

   ├── Insurance Case ID

   ├── RTO Case ID

   ├── Exchange Request ID

   └── Delivery ID



Inventory records can exist before a customer, so Inventory is primarily anchored by:

```
vehicle_id / VIN / chassis_no
```

Once reserved/allocated:

**vehicle → booking → customer**

---

#### 2. COMMON POST-BOOKING FLOW

The normal operational journey is:

**Booking Confirmed**

↓

**Vehicle Allocation**

↓

**Finance** if required

↓

**Insurance**

↓

**RTO**

↓

**Accessories / PDI / Documents**

↓

**Ready for Delivery**

↓

**Delivered**

↓

**Customer Relationship Follow-up**

Important:

These stages may overlap operationally.

For example Finance and Insurance can run in parallel where the dealership's process allows.

So do not hard-code everything as one rigid sequential transaction.

---

#### 3. DATA SCOPE

Every operational user supports:

-

```
ONE_BRANCH
```

1.

```
SELECTED_BRANCHES
```

1.

```
ALL_BRANCHES
```

Example:

**RTO Executive**

Scope:

```
SELECTED_BRANCHES
```

→ MG Road
→ Whitefield

They cannot see RTO cases from other branches.

Supabase RLS enforces this server-side.

---

#### 4. COMMON OPERATIONAL UI STANDARD

Keep all operational screens visually consistent.

###### Dashboard

Use:

**shadcn Card**

for KPI cards.

Typical structure:

**5–8 KPI Cards**

↓

**1–2 useful Apache ECharts charts**

↓

**Priority / Requires Attention**

↓

**Recent Activity or Main Work Queue**

Do not fill operational dashboards with unnecessary charts.

###### Lists

Use:

**shadcn Table + TanStack Table**

###### Detail pages

Use:

- Cards
- Tabs
- Badge
- Progress
- Accordion
- Sheet
- Dialog
- Timeline layout
- Document cards

###### Charts

**Apache ECharts only**

No Recharts/Chart.js/ApexCharts.

---

#### 5. COMMON SEARCH/TABLE RULES

Operational tables use server-side:

- filtering
- sorting
- pagination
- search

Default rows:

**25**

Options:

**25 / 50 / 100**

Search should be page-local.

Examples:

- Customer Name
- Customer Phone
- Booking ID
- VIN
- Registration Number
- Case ID

Debounce:

approximately **300ms**.

Use PostgreSQL indexes for:

- tenant
- branch
- booking
- customer
- VIN
- case status
- dates

Use `pg_trgm + GIN` only where fuzzy text search is useful.

---

#### 6. COMMON COMMUNICATION RULE

Operational departments do **not** need a full WhatsApp inbox.

There are two communication modes.

###### CRM-connected channel

If dealership has WhatsApp/SMS/Email configured:

**Operational User → Notify Customer → approved template → provider sends message**

CRM automatically records:

- channel
- template
- user
- time
- provider status
- delivery status if provider supplies it

###### Manual communication

If employee communicates outside CRM:

Button:

**Mark as Contacted**

or:

**Mark as Sent**

Capture:

- Channel: Call / WhatsApp / SMS / Email / Other
- Mode: Manual
- User
- Date/time
- Optional note

Example Customer 360 timeline:

> Delivery confirmation manually sent through WhatsApp by Rahul at 3:20 PM.

Never pretend manual communication was sent by CRM.

---

#### 7. COMMON CUSTOMER 360 TIMELINE

Operational activities feed one timeline.

Example:

Lead Created

Qualified

Sales Consultant Assigned

Test Drive Completed

Quotation Sent

Booking Confirmed

Vehicle Allocated

Finance Approved

Insurance Policy Issued

RTO Submitted

Registration Number Allocated

PDI Completed

Ready for Delivery

Vehicle Delivered

Delivery Feedback Received



This should become the dealership's complete customer history.

---

#### 8. INVENTORY DEPARTMENT

##### Final Sidebar

1. **Dashboard**
2. **Vehicle Inventory**
3. **Stock Allocation**
4. **Stock Ageing**
5. **Stock Transfer**
6. **Reports**
7. **My Performance**

Optional client features can appear dynamically.

---

#### 9. Inventory Dashboard

###### KPI Cards

- Total Stock
- Available
- Reserved
- Allocated
- In Transit
- Ageing Stock
- Ready for Delivery
- Low Stock Models

###### Charts

**Apache ECharts Donut**

Stock Distribution by Model.

**Apache ECharts Bar**

Branch-wise Stock.

Optional:

**ECharts Donut**

Stock Ageing Distribution.

###### Requires Attention

- Zero Stock
- Low Stock
- High Booking Demand / Low Stock
- Allocation Pending
- Transfer Delayed
- 90+ Day Stock

---

#### 10. Vehicle Inventory

Inventory is the source of truth for physical dealership vehicle stock.

Main fields:

- Vehicle ID
- VIN / Chassis No.
- Engine No.
- Brand
- Model
- Variant
- Colour
- Fuel
- Transmission
- Manufacturing Month/Year
- Current Branch
- Stock Status
- Received Date
- Days in Stock
- Reserved Booking
- Customer if allocated
- Expected Arrival
- Current Location/yard where applicable

Statuses:

**Incoming → Available → Reserved → Allocated → Ready for Delivery → Delivered**

Additional:

**In Transit | Hold**

---

#### 11. Inventory Table

Columns:

**VIN | Model | Variant | Colour | Branch | Received Date | Days in Stock | Booking | Allocation | Status | Action**

Actions:

- Open
- Edit permitted fields
- Reserve
- Allocate
- Transfer
- Put on Hold
- View History

Every movement is audited.

---

#### 12. Stock Allocation

Triggered mainly by booking.

Flow:

**Booking confirmed**

→ allocation request

→ suitable stock identified

→ vehicle reserved

→ VIN allocated

→ booking updated

Modes:

###### Manual Allocation

Inventory user selects vehicle.

###### Auto Allocation

CRM suggests/allocates based on configured rules.

Matching factors can include:

- Model
- Variant
- Colour
- Branch
- Booking priority
- Vehicle age
- Customer commitment
- Arrival status

---

#### 13. Stock Allocation Table

Columns:

- Allocation ID
- Booking
- Customer
- Requested Model
- Variant
- Colour
- Branch
- Suggested VIN
- Consultant
- Priority
- Request Date
- Status
- Action

Statuses:

**Pending | Suggested | Reserved | Allocated | On Hold | Cancelled**

---

#### 14. Stock Ageing

Default ranges:

- 0–30
- 31–60
- 61–90
- 90+

Client Admin can configure ranges.

###### Charts

**ECharts Stacked Bar**

Ageing units by branch.

**ECharts Donut**

Age ranges.

**ECharts Line**

Ageing-stock trend.

###### Table

**VIN | Model | Variant | Branch | Days in Stock | Stock Value | Enquiries | Reservations | Last Activity | Risk**

Risk:

**Normal | Watchlist | High Risk | Critical**

Inventory can suggest stock action, but pricing/discount approval follows configured authority.

---

#### 15. Stock Transfer

Flow:

**Transfer Requested → Approved → Dispatched → In Transit → Received**

Table:

- Transfer ID
- VIN / Model
- From Branch
- To Branch
- Requested By
- Approved By
- Dispatch Date
- ETA
- Received Date
- Transporter if used
- Status

Detail page includes full transfer timeline.

---

#### 16. FINANCE DEPARTMENT

##### Final Sidebar

1. **Dashboard**
2. **Finance Cases**
3. **Pending Documents**
4. **Applications**
5. **Disbursement**
6. **Reports**
7. **My Performance**

Optional lender-specific pages can be enabled later.

---

#### 17. Finance Dashboard

###### KPI

- Total Cases
- Documents Pending
- Applications Pending
- Submitted
- Approved
- Rejected
- Disbursement Pending
- Completed
- Delivery Risk

###### Charts

**ECharts Donut**

Finance Case Status.

**ECharts Bar**

Applications / approvals by lender.

Optional:

**ECharts Line**

Average processing time.

---

#### 18. Finance Workflow

Finance Case Created

↓

Customer Documents

↓

Loan Details Captured

↓

Lender Selected

↓

Application Submitted

↓

Approved / Rejected / Query

↓

Disbursement

↓

Completed



Finance may be:

**Required / Not Required**

If customer self-finances, Finance module simply records:

**Self Finance / Not Applicable**

---

#### 19. Finance Case

Fields:

- Finance Case ID
- Customer
- Booking
- Vehicle
- Requested Loan
- Down Payment
- Lender
- Application ID
- Tenure
- Rate/ROI if recorded
- Applicant details
- Co-applicant if relevant
- Documents
- Approval Amount
- Approval Date
- Disbursement
- Delivery Date
- Status

---

#### 20. Finance Case Table

Columns:

**Case ID | Customer | Booking | Model | Lender | Loan Amount | Documents | Application | Approval | Disbursement | Delivery Date | Status | Action**

Sales Consultant can view status through Customer 360.

Sales Consultant should not process lender workflow.

---

#### 21. INSURANCE DEPARTMENT

##### Final Sidebar

1. **Dashboard**
2. **Insurance Cases**
3. **Renewals** — optional
4. **Claims** — optional
5. **Insurer Directory** — optional
6. **Reports**
7. **My Performance**

For a simple new-car dealership implementation, default:

**Dashboard → Insurance Cases → Reports**

Renewals/Claims can be enabled by client.

---

#### 22. Insurance Dashboard

###### KPI

- Total Cases
- New Cases
- Documents Pending
- Proposal Pending
- Policy Pending
- Policies Issued
- Insurance Ready
- Delivery Risk

###### Charts

**ECharts Donut**

Insurance status.

**ECharts Bar**

Cases/policies by insurer.

No unnecessary third/fourth chart.

---

#### 23. Insurance Workflow

Case Created

↓

Documents Received

↓

Proposal Prepared/Sent

↓

Insurer Review / Approval

↓

Policy Generated

↓

Insurance Ready

↓

Ready for Next Operational Step



Do not hard-code Insurance → RTO as mandatory for every client.

Instead:

once insurance requirement is satisfied:

```
insurance_ready = true
```

and workflow engine determines what comes next.

---

#### 24. Insurance Case Table

Columns:

- Insurance Case ID
- Customer
- Booking
- Vehicle
- Insurer
- Policy Type
- Premium
- Documents
- Proposal Date
- Policy Status
- Policy Number
- Expiry
- Delivery Date
- Status
- Action

---

#### 25. Insurance Detail

Show:

###### Customer/Booking

- Customer
- Booking ID
- Vehicle
- Branch
- Sales Consultant
- Delivery Date

###### Insurance

- Insurer
- Policy Type
- Premium
- Proposal
- Policy Number
- Policy Dates

###### Documents

Required document checklist.

###### Timeline

- Case created
- documents received
- proposal submitted
- approved
- policy generated

###### Actions

- Edit Case
- Upload Document
- Mark Proposal Sent
- Update Insurer Status
- Mark Policy Generated
- Mark Insurance Ready

---

#### 26. RTO DEPARTMENT

##### Final Sidebar

Keep it compact:

1. **Dashboard**
2. **RTO Cases**
3. **Reports**
4. **My Performance**

Inside **RTO Cases**, use tabs:

- New
- Documents Pending
- Submitted
- Registration Pending
- Number Allocation
- Completed

This is cleaner than putting every status in sidebar.

---

#### 27. RTO Dashboard

###### KPI

- New Cases
- Documents Pending
- Submitted
- Registration Pending
- Numbers Pending
- Completed Today
- Delivery Risk

###### Charts

**ECharts Donut**

RTO Status.

Optional:

**ECharts Bar**

Cases by RTO Office.

###### Priority Cases

Show upcoming deliveries where RTO is blocking completion.

---

#### 28. RTO Workflow

Case Created

↓

Documents Verified

↓

Application Submitted

↓

Registration Processing

↓

Registration Number Allocated

↓

Completed



Client Admin/configuration defines exact required stages/documents.

Do not hard-code every State/RTO process into generic application logic.

---

#### 29. RTO Table

Columns:

**RTO Case ID | Customer | Booking | VIN | RTO Office | Registration Type | Application Date | Application No. | Registration No. | Delivery Date | Status | Action**

---

#### 30. RTO Detail

Sections:

- Customer
- Booking
- Vehicle/VIN
- RTO office
- Application details
- Required documents
- Registration details
- Number allocation
- Attachments
- Remarks
- Timeline

---

#### 31. USED CAR / EXCHANGE

##### Final Sidebar

1. **Dashboard**
2. **Exchange Requests**
3. **Evaluations**
4. **Accepted Exchanges**
5. **Reports**
6. **My Performance**

---

#### 32. Exchange Dashboard

###### KPI

- New Requests
- Evaluation Pending
- Evaluated
- Customer Approval Pending
- Accepted
- Rejected
- Average Evaluation Value

###### Charts

**ECharts Donut**

Exchange Status.

**ECharts Bar**

Exchange requests by model/brand.

---

#### 33. Exchange Workflow

Exchange Requested

↓

Existing Vehicle Captured

↓

Inspection / Evaluation Requested

↓

Vehicle Evaluated

↓

Offer Generated

↓

Customer Decision

↓

Accepted / Rejected

↓

Exchange Confirmed




---

#### 34. Existing Vehicle Data

Store:

- Brand
- Model
- Variant
- Registration
- Model Year
- Fuel
- Ownership
- KM
- Condition
- RC details
- Insurance if relevant
- Photos
- Documents
- Customer Expected Price
- Evaluated Price

---

#### 35. Exchange Table

Columns:

**Exchange ID | Customer | Booking | Existing Vehicle | Registration | Expected Value | Evaluated Value | Evaluator | Evaluation Date | Status | Action**

The accepted exchange amount can flow into quotation/booking adjustment through approval rules.

---

#### 36. DELIVERY DEPARTMENT

##### Final Sidebar

1. **Dashboard**
2. **Upcoming Deliveries**
3. **Delivery Planner**
4. **Pending Checklist**
5. **Ready for Delivery**
6. **Delivered**
7. **Delivery Photos**
8. **Feedback**
9. **Reports**
10. **My Performance**

If client wants a simpler setup:

**Dashboard → Deliveries → Reports**

and use tabs for the rest.

---

#### 37. Delivery Dashboard

###### KPI

- Today
- Tomorrow
- Pending Vehicle Allocation
- Pending Finance
- Pending Insurance
- Pending RTO
- Pending PDI
- Ready
- Delivered

###### Chart

**ECharts Donut**

Delivery readiness/status.

###### Priority Deliveries

Show:

- Customer
- Vehicle
- Delivery Date
- Blocking Department
- Current Status

---

#### 38. Delivery Readiness Flow

Booking

↓

Vehicle Allocated

↓

Finance Cleared if applicable

↓

Insurance Ready

↓

RTO Ready

↓

Accessories Complete

↓

PDI Complete

↓

Documents Ready

↓

Ready for Delivery

↓

Delivered




---

#### 39. Delivery Detail

Header:

- Customer
- Booking
- Vehicle
- VIN
- Consultant
- Branch
- Delivery Date

###### Workflow tracker

**Booking → Vehicle → Finance → Insurance → RTO → Accessories → PDI → Ready → Delivered**

If Finance is not applicable, show it as:

**N/A / Cleared**

rather than blocking the workflow.

---

#### 40. Delivery Checklist

###### Vehicle Preparation

- PDI
- Exterior inspection
- Interior inspection
- Cleaning
- Fuel level
- Tyre pressure
- Battery
- accessories

###### Registration

- Registration completed
- Number plate
- documents

###### Insurance

- Policy verified

###### Documentation

- Invoice
- Receipt
- Warranty
- Manual
- Finance documentation if applicable

###### Final Handover

- Key handover
- Vehicle explanation
- Customer signature
- Delivery photo
- Feedback request

---

#### 41. Mark Delivered

Only available when mandatory configured items are completed.

Store:

-

```
delivered_at
```

1.

```
delivered_by
```

1. booking
2. VIN
3. customer
4. signature
5. delivery photos
6. notes

Then Customer 360 gets:

**Vehicle Delivered**

event.

---

#### 42. CUSTOMER RELATIONSHIP / CUSTOMER CARE

##### Final Sidebar

1. **Dashboard**
2. **Customer Cases**
3. **Follow-ups**
4. **Feedback**
5. **Reviews**
6. **Complaints & Escalations**
7. **Reports**
8. **My Performance**

---

#### 43. Customer Relationship Dashboard

###### KPI

- Open Cases
- Follow-ups Due
- Feedback Pending
- Review Requests Pending
- Complaints Open
- SLA Risk
- Resolved Today
- Average Resolution Time

###### Charts

**ECharts Donut**

Cases by status/type.

**ECharts Line**

Opened vs Resolved.

Optional:

**ECharts Bar**

Customer satisfaction by branch.

---

#### 44. Customer Care Cases

Types:

- Delivery Follow-up
- Complaint
- Feedback
- Documentation Query
- Review Request
- Sales Experience
- Other

Flow:

**New → Assigned → In Progress → Customer Contacted → Resolved → Closed**

---

#### 45. Customer Care Table

Columns:

**Case ID | Customer | Vehicle | Booking | Branch | Type | Priority | Owner | SLA | Last Activity | Status | Action**

Customer 360 remains the source of truth.

Do not create a duplicate customer profile in Customer Care.

---

#### 46. DIGITAL MARKETING

##### Final Sidebar

1. **Dashboard**
2. **Lead Sources**
3. **Campaigns**
4. **Social Posts**
5. **Reviews**
6. **AI Content / Image**
7. **Performance**
8. **Reports**

Integration credentials/configuration remain mainly under Client Admin/System Administrator.

---

#### 47. Digital Marketing Dashboard

###### KPI

- Leads Generated
- Qualified Leads
- Bookings
- Conversion %
- Active Campaigns
- Cost per Lead if available
- Reviews
- Posts Published

###### Charts

**ECharts Bar**

Leads vs bookings by source.

**ECharts Line**

Campaign lead trend.

**ECharts Donut**

Lead source share.

**ECharts Funnel**

Lead → Qualified → Booking.

---

#### 48. Lead Sources

Sources include:

- Facebook
- Instagram
- Google Ads
- Website
- WhatsApp
- CarWale
- CarDekho
- Justdial
- IndiaMART
- Manual
- Other

Table:

**Source | Leads | Qualified | Test Drives | Quotations | Bookings | Conversion | CPL if available**

---

#### 49. Campaigns

Fields:

- Campaign
- Platform
- Source
- Branch Scope
- Start Date
- End Date
- Leads
- Qualified
- Test Drives
- Bookings
- Cost
- CPL
- Conversion

Do not assume every provider supplies spend/cost.

Only show cost metrics when integrated data provides them.

---

#### 50. Social Media

If social provider integration is enabled:

Digital Marketing can:

- create draft post
- schedule
- publish
- view publishing status
- view connected pages/accounts according to permission

No provider credentials exposed to normal Digital Marketing users.

---

#### 51. AI Content / Image

If enabled:

- Generate social caption
- Generate post variants
- Generate campaign ideas
- Generate image
- Rewrite content

Every generation consumes dealership AI credits according to Super Admin pricing/configuration.

Show estimated credit cost before generation where practical.

---

#### 52. OPERATIONAL HANDOFF EVENTS

Departments should communicate through system events rather than employees manually checking constantly.

Examples:

###### Booking Confirmed

Notify:

- Inventory
- Finance if required
- Insurance depending workflow

###### Vehicle Allocated

Notify:

- Sales Consultant
- Delivery
- relevant operational teams

###### Finance Approved

Update Booking + Customer 360.

###### Insurance Ready

Update Booking + downstream readiness.

###### RTO Completed

Update Delivery readiness.

###### Delivery Ready

Notify Sales Consultant / Customer if configured.

###### Delivered

Notify:

- Customer Relationship
- Digital Marketing review workflow if enabled

---

#### 53. TASKS

Operational departments do **not need a separate complicated project-management Tasks module**.

Task reminders can appear inside:

- work queue
- dashboard priority list
- case detail
- notification center

If a client enables a common Tasks module, it can appear dynamically.

Default operational UI should remain simpler.

---

#### 54. DOCUMENT STORAGE

Use private object storage.

Recommended:

**Tigris Data private S3-compatible buckets**

with S3-compatible abstraction where useful.

Store:

- Insurance documents
- Finance documents
- RC
- RTO docs
- Vehicle photos
- Exchange photos
- Invoice
- Warranty
- Delivery photos
- Customer signature

Database stores:

- object path
- mime type
- size
- owner/resource
- uploaded\_by
- timestamp
- document type

Authorized access gets short-lived signed URL.

---

#### 55. STATUS CHANGE HISTORY

Never overwrite history.

Every workflow transition stores:

- Record ID
- Previous Status
- New Status
- Changed By
- Changed At
- Reason
- Notes
- Source

Example:

RTO-1044

Registration Pending

→ Number Allocated

Changed By: Rahul

13 Aug 2026 2:43 PM




---

#### 56. COMMON NOTES

Every department record can have internal notes.

Store:

- note\_id
- record\_id
- user
- role
- timestamp
- note

Do not delete historical notes casually.

If edited, maintain edit history where necessary.

---

#### 57. COMMON AUDIT RULES

Audit important actions:

- case created
- status changed
- document uploaded
- document removed
- vehicle allocated
- transfer created
- finance approval updated
- policy issued
- RTO completed
- delivery completed
- customer communication marked
- manual override

Audit logs should not be editable by ordinary operational users.

---

#### 58. ROLE/PERMISSION EXAMPLES

###### Inventory

```
inventory.view
inventory.create
inventory.edit
inventory.allocate
inventory.reserve
inventory.transfer
```

###### Finance

```
finance.view
finance.create
finance.edit
finance.submit
finance.update_approval
finance.update_disbursement
```

###### Insurance

```
insurance.view
insurance.create
insurance.edit
insurance.issue_policy
```

###### RTO

```
rto.view
rto.create
rto.edit
rto.submit
rto.allocate_number
rto.complete
```

###### Delivery

```
delivery.view
delivery.edit
delivery.checklist
delivery.mark_ready
delivery.complete
```

One module's permission does not automatically give access to another module.

---

#### 59. SHOWROOM MANAGER / GM VISIBILITY

Showroom Manager and GM normally see operational status.

Example:

Booking BK-1004



Vehicle Allocation ✅

Finance ✅

Insurance ✅

RTO ⏳

Delivery Waiting



But they should not automatically get buttons such as:

**Approve Finance**
**Issue Policy**
**Allocate Registration Number**

unless explicitly granted.

---

#### 60. CLIENT ADMIN CONTROL

Client Admin can enable/disable operational modules.

Example:

Dealership A:

- Inventory ✅
- Finance ✅
- Insurance ✅
- RTO ✅
- Delivery ✅
- Exchange ❌

Dealership B:

- Inventory ✅
- Finance ❌
- Insurance ✅
- RTO ✅
- Delivery ✅
- Exchange ✅

Sidebar changes dynamically according to:

**Module enabled + Role permission + User data scope**

---

#### 61. CLIENT-SPECIFIC SIMPLICITY

This is important for your client.

Do not force every optional page into every dealership.

Example Insurance:

###### Simple client

**Dashboard | Cases | Reports**

###### Larger client

**Dashboard | Cases | Renewals | Claims | Insurer Directory | Reports**

Same backend architecture.

Different enabled UI.

---

#### 62. SERVER STATE / CACHE

Use TanStack Query.

Default:

```
staleTime = 60 seconds
gcTime = 30 minutes
refetchOnWindowFocus = false
refetchOnReconnect = true
```

Manual Refresh:

**max 3 refreshes / minute / user / page-resource**

Mutation invalidates only affected query keys.

---

#### 63. ZUSTAND

Only for lightweight UI state:

- selected tabs
- local filters
- open modal
- selected rows
- temporary form state

Do not store operational server data permanently in Zustand.

---

#### 64. WEB PERSISTENCE

Use IndexedDB only for selected non-sensitive cached data.

Never persist client-side:

- provider credentials
- MFA secrets
- raw private documents
- signed URLs beyond intended life
- full sensitive transcripts
- authentication secrets

---

#### 65. BACKGROUND JOBS

Use Trigger.dev for:

- report exports
- notifications
- provider sync
- retry workflows
- SLA checks
- scheduled reminders
- AI generation
- long document tasks if introduced

Ordinary record updates remain normal API/database operations.

---

#### 66. FINAL CUSTOMER 360 OPERATIONAL VIEW

Customer 360 should eventually support:

**Overview**

**Leads**

**Calls**

**Conversations**

**Follow-ups**

**Appointments**

**Test Drives**

**Quotations**

**Bookings**

**Vehicles**

**Exchange**

**Finance**

**Insurance**

**RTO**

**Delivery**

**Customer Care**

**Documents**

**Timeline**

Operational users only see sections they have permission to view.

---

#### 67. FINAL DEPARTMENT OWNERSHIP

| **Process**                     | **Primary Owner**     |
| ------------------------------- | --------------------- |
| Physical vehicle stock          | Inventory             |
| Vehicle allocation              | Inventory             |
| Loan processing                 | Finance               |
| Insurance policy                | Insurance             |
| Registration                    | RTO                   |
| Exchange valuation              | Exchange              |
| Delivery readiness/handover     | Delivery              |
| Post-sale customer care         | Customer Relationship |
| Campaign/source performance     | Digital Marketing     |
| Customer-facing sales ownership | Sales Consultant      |
| Showroom coordination           | Showroom Manager      |
| Multi-showroom sales oversight  | GM                    |
| Configuration/access            | Client Admin          |

---

#### FINAL OVERALL FLOW

CUSTOMER

   ↓

LEAD

   ↓

QUALIFIED

   ↓

SALES CONSULTANT

   ↓

TEST DRIVE / QUOTATION

   ↓

BOOKING

   ↓

────────────────────────────────

OPERATIONAL PROCESS

────────────────────────────────

   ↓

VEHICLE ALLOCATION

   ↓

FINANCE (IF REQUIRED)

   ↓

INSURANCE

   ↓

RTO

   ↓

ACCESSORIES / PDI / DOCUMENTS

   ↓

READY FOR DELIVERY

   ↓

DELIVERED

   ↓

CUSTOMER RELATIONSHIP

   ↓

FEEDBACK / REVIEW



And throughout the entire lifecycle:

**One Customer UUID → multiple leads → multiple bookings/purchases → multiple vehicles → complete history.**

This is the version I would **freeze as the final Operational Departments PRD**. Next we can move to **Business Owner**, then keep **Super Admin for last** as planned.


### 54.8 System Administrator — detailed page PRD

##### SYSTEM ADMINISTRATOR — FINAL WEB PRD

##### 1. Role Purpose

System Administrator is the dealership’s **technical/delegated administration role**.

It is different from Client Admin.

**Client Admin** controls the dealership/business configuration and has final tenant-side authority.

**System Administrator** handles the technical administration Client Admin delegates, such as users, permissions, integrations, master data, automation, alerts, security, audit, backups and system health.

System Administrator does **not automatically own Sales, Finance, Insurance, RTO, Inventory or Delivery workflows**.

Those modules appear only when additional permissions are granted.

---

#### 2. Data Scope

System Administrator can be:

**ONE\_BRANCH**

**SELECTED\_BRANCHES**

**ALL\_BRANCHES**

Example:

System Administrator: Ravi



Scope:

SELECTED\_BRANCHES



✓ MG Road

✓ Whitefield

✗ HSR



Every admin page respects that scope.

If:

**ALL\_BRANCHES**

is selected:

- Branch selector disabled
- Previous branch selections cleared

If:

**ONE\_BRANCH / SELECTED\_BRANCHES**

is selected:

- `ALL_BRANCHES` cannot also be selected

A System Admin can never manage data outside their assigned scope.

---

#### 3. Final Sidebar

1. **Dashboard**
2. **Users**
3. **Roles & Permissions**
4. **Branches & Access**
5. **Master Data**
6. **Integrations**
7. **Automation Rules**
8. **Templates**
9. **Alerts & Notifications**
10. **System Health**
11. **Audit Logs**
12. **Backup & Data Management**
13. **Security**
14. **Reports**

This is **Web only** for MVP.

---

#### 4. Contextual Pages

Not sidebar pages:

- User Detail
- Role Detail
- Permission Detail
- Branch Access Detail
- Master Data Editor
- Integration Detail
- Field Mapping
- Integration Logs
- Automation Builder
- Template Editor
- Alert Rule Detail
- Audit Event Detail
- Backup Detail
- Security Event Detail

---

#### 5. Shared UI Technology

Use:

**Next.js + TypeScript + Tailwind + shadcn/ui**

Main shadcn components:

- Card
- Table
- Tabs
- Badge
- Button
- Input
- Select
- Command
- Popover
- Dialog
- AlertDialog
- Sheet
- Checkbox
- RadioGroup
- Switch
- Accordion
- Tooltip
- DropdownMenu
- Progress
- Separator
- ScrollArea
- Skeleton
- Form
- Textarea

Tables:

**TanStack Table + shadcn Table**

Charts:

**Apache ECharts only**

Server state:

**TanStack Query**

UI state:

**Zustand**

---

#### 6. Dashboard

Purpose:

> Is the dealership CRM technically healthy and properly configured?

###### KPI Cards

- Total Users
- Active Users
- Locked Users
- MFA Compliance
- Active Integrations
- Integration Errors
- Failed Automations
- Pending Alerts
- API/Provider Errors
- Storage Usage
- AI Usage Today
- Security Alerts

Use `shadcn Card`.

---

#### 7. System Health Overview

Use **Apache ECharts Line**:

- API Requests
- Successful Integration Events
- Failed Integration Events
- Background Job Failures

Time range:

- 24 Hours
- 7 Days
- 30 Days

Do not expose infrastructure internals that the dealership admin does not need.

---

#### 8. Integration Health

Use **Apache ECharts Donut**:

- Healthy
- Warning
- Failed
- Disabled

Then list:

**Provider | Connection | Branch Scope | Last Success | Last Error | Status**

Click opens Integration Detail.

---

#### 9. Requires Attention

Show cards/list:

- Provider connection failed
- Lead mapping error
- Automation failed repeatedly
- User locked
- Required MFA missing
- Expired/invalid provider credential
- Backup failed
- Storage threshold warning
- Suspicious login/security event
- Branch configuration incomplete

---

#### 10. Users

System Admin can manage users **only if Client Admin grants user-management permission**.

Possible permissions:

-

```
users.view
```

1.

```
users.create
```

1.

```
users.edit
```

1.

```
users.disable
```

1.

```
users.reset_access
```

1.

```
users.reset_mfa
```

1.

```
users.change_scope
```

---

#### 11. Users Table

Columns:

- User
- Email
- Phone
- Employee ID
- Role
- Department
- Scope Type
- Branches
- Team
- MFA
- Last Login
- Status
- Action

Filters:

- Search
- Role
- Department
- Branch
- Team
- Scope
- MFA
- Status

Actions depend on permission:

- Open
- Edit
- Disable
- Reset Access
- Reset MFA
- Change Scope

---

#### 12. User Creation Ceiling

System Admin does **not automatically have permission to create every role**.

Client Admin configures:

**Allowed Roles to Create**

Example:

System Admin may be allowed to create:

- Team Manager
- Sales Consultant
- Telecaller
- Finance User
- Insurance User
- RTO User
- Inventory User

but not:

- Client Admin
- Business Owner
- Super Admin

Whether System Admin can create another System Administrator is also a delegated permission.

---

#### 13. User Scope Ceiling

A System Admin can never assign a user a scope wider than their own.

Example:

System Admin:

**MG Road + Whitefield**

Can create:

**Sales Consultant → MG Road**

or:

**Finance User → MG Road + Whitefield**

Cannot create:

**Finance User → ALL\_BRANCHES**

---

#### 14. Roles & Permissions

System Administrator can maintain role permissions only when granted:

```
roles.manage
```

Default purpose:

- View role matrix
- Troubleshoot access
- Assign delegated permissions
- Maintain custom roles

Role remains separate from branch/data scope.

---

#### 15. Role Table

Columns:

- Role Name
- Department
- Type
- Users Assigned
- Permission Count
- Status
- Last Updated
- Action

Types:

**System | Custom**

---

#### 16. Permission Matrix

Organize using shadcn:

**Tabs + Accordion + Checkbox/Switch**

Groups:

- Sales
- Customer
- Calls
- Test Drives
- Quotations
- Bookings
- Inventory
- Finance
- Insurance
- RTO
- Exchange
- Delivery
- Customer Relationship
- Digital Marketing
- Administration
- Integrations
- AI
- Reports
- Security

Do not show one huge unstructured checkbox page.

---

#### 17. Permission Dependency Validation

If enabling a high-level action, validate prerequisite permissions.

Example:

```
quotation.approve_discount
```

may require:

```
quotation.view
```

Do not silently grant unrelated permissions.

Show dependency warning before save.

---

#### 18. Branches & Access

This is not full business Branch Management unless explicitly granted.

Purpose:

- View authorized branches
- Manage user access by branch
- Verify branch mappings
- Troubleshoot branch scope
- Assign technical integration scope

###### Table

- Branch
- Code
- Status
- Users
- Teams
- Integrations
- Admin Access
- Last Configuration Update
- Action

---

#### 19. Branch Access Matrix

Useful contextual page:

Rows:

**Users / Roles**

Columns:

**Branches**

Cells:

**No Access / View / Assigned**

Use this carefully for visibility, not to replace proper role/scope model.

---

#### 20. Master Data

System Administrator can maintain configurable master data if permission granted.

Examples:

- Vehicle Brands
- Models
- Variants
- Colours
- Fuel Types
- Transmission Types
- Lead Sources
- Lost Reasons
- Follow-up Reasons
- Call Outcomes
- Appointment Types
- Finance Lenders
- Insurance Providers
- RTO Offices
- Document Types
- Delivery Checklist Types

---

#### 21. Master Data UI

Tabs by category.

Table:

- Name
- Code
- Category
- Branch Scope if applicable
- Sort Order
- Active
- Updated By
- Updated At
- Action

Actions:

- Add
- Edit
- Disable
- Reorder

Prefer **Disable/Archive** over deleting values already used historically.

---

#### 22. Integrations

One of System Administrator’s main responsibilities.

Categories:

###### Lead Sources

- Meta/Facebook
- Instagram
- Google Ads
- Website API
- CarWale
- CarDekho
- Justdial
- IndiaMART

###### Communication

- WhatsApp Business
- IVR/Calling
- Email

###### Platform Services

- Maps
- AI
- Voice AI
- future adapters

---

#### 23. Integration Table/Cards

Show:

- Provider
- Connection Name
- Type
- Scope
- Status
- Last Successful Request
- Last Sync
- Last Error
- Error Count
- Action

Badges:

- Connected
- Warning
- Failed
- Disabled

---

#### 24. Integration Detail

Tabs:

**Overview | Authentication | Scope | Field Mapping | Source Mapping | Sync History | Errors | Test Tools**

Actions:

- Test Connection
- Send Test Lead
- Sync Now
- Disable
- Replace Credential

Never expose stored secret values.

---

#### 25. Field Mapping

Example:

Provider:

full\_name



CRM:

customer\_name



or:

Provider:

vehicle\_interest



CRM:

interested\_model



Flow:

**External Source → Mapping → Validation → Normalization → Canonical CRM Record**

Use:

- shadcn Select
- Table
- Badge
- Input
- Button

---

#### 26. Integration Scope

Every connection can use:

- ONE\_BRANCH
- SELECTED\_BRANCHES
- ALL\_BRANCHES

Example:

Meta Account A:

**MG Road**

IVR Account B:

**MG Road + Whitefield**

Website Endpoint:

**ALL\_BRANCHES**

---

#### 27. Integration Error Management

Table:

- Time
- Provider
- Connection
- Branch
- Event Type
- External ID
- Error
- Retry Count
- Last Retry
- Status
- Action

Actions:

- Open
- Retry
- Ignore/Acknowledge
- Disable connection

Use **Trigger.dev** for retry/background jobs.

---

#### 28. Automation Rules

System Admin can create automations when permission granted.

Example:

**Trigger: Lead Created**

Condition:

```
source = Facebook
```

Action:

**Assign to Branch A / Team A**

Other examples:

- Lead SLA warning
- Follow-up reminder
- Booking status notification
- Insurance-ready notification
- RTO complete notification
- Delivery-ready notification
- Escalation creation
- Review request after delivery

---

#### 29. Automation List

Columns:

- Rule Name
- Trigger
- Module
- Branch Scope
- Status
- Last Run
- Success
- Failures
- Updated By
- Action

Actions:

- Open
- Edit
- Clone
- Disable
- View Runs

---

#### 30. Automation Builder

Structure:

**WHEN**

Trigger

↓

**IF**

Conditions

↓

**THEN**

Actions

Example:

WHEN:

RTO Case Completed



IF:

Delivery not already completed



THEN:

Update Delivery Readiness

Notify Delivery User

Notify Sales Consultant



Use simple cards and step builder.

Do not create an overly complicated BPMN engine for MVP.

---

#### 31. Automation Safety

Prevent:

- infinite loops
- duplicate repeated actions
- unauthorized module actions
- cross-tenant actions

Use idempotency keys where required.

Heavy/delayed automation execution through **Trigger.dev**.

---

#### 32. Templates

Manage approved communication templates.

Types:

- WhatsApp
- SMS
- Email
- Push notification
- Internal notification

###### Table

- Template Name
- Channel
- Purpose
- Language
- Provider Template ID
- Approval Status
- Active
- Updated
- Action

---

#### 33. Template Editor

Fields:

- Name
- Channel
- Category
- Subject if Email
- Content
- Variables
- Language
- Branch Scope
- Status

Example variables:

```
{{customer_name}}
{{vehicle_model}}
{{booking_id}}
{{delivery_date}}
```

Preview before save.

---

#### 34. Alerts & Notifications

Configure internal alerts.

Examples:

- New Lead SLA Risk
- Follow-up Overdue
- Integration Failure
- Low AI Credits
- Stock Ageing
- Booking Delay
- Finance Pending
- RTO Delay
- Delivery Risk
- Security Alert

---

#### 35. Alert Rule

Fields:

- Alert Name
- Trigger
- Severity
- Module
- Branch Scope
- Recipient Role/User
- Notification Channel
- Cooldown
- Active

Severity:

**Info | Warning | Critical**

Avoid sending repeated alerts every minute.

Use cooldown/deduplication.

---

#### 36. System Health

This page gives technical health without making the user an infrastructure engineer.

###### KPI

- API Status
- Integration Health
- Failed Jobs
- Queue Backlog
- Storage Usage
- Database Connection Health
- Realtime Status
- Last Successful Backup

###### Charts

**ECharts Line**

- Successful jobs
- Failed jobs

**ECharts Bar**

- Errors by integration/service

---

#### 37. System Health Table

- Service
- Category
- Status
- Last Check
- Last Error
- Failure Count
- Action

Possible services:

- Lead ingestion
- WhatsApp
- IVR
- Email
- Trigger.dev
- AI provider
- Maps
- Storage

Do not expose platform Super Admin-only infrastructure secrets.

---

#### 38. Audit Logs

Critical System Admin page.

Track:

- User login
- Failed login
- User created
- User disabled
- Role change
- Permission change
- Scope change
- Integration update
- Credential replacement
- Automation update
- Master-data update
- Security configuration
- Backup event
- Data export
- Admin override

---

#### 39. Audit Table

Columns:

- Time
- User
- Role
- Branch
- Module
- Action
- Resource
- Result
- Session/IP info where appropriate
- Action

Filters:

- Date
- User
- Module
- Branch
- Action
- Result

Audit events are effectively immutable from standard admin UI.

---

#### 40. Backup & Data Management

This page manages dealership-level backup/export tools supported by the platform.

Do **not** imply that System Admin directly downloads raw PostgreSQL server backups if the platform does not expose that.

Supported concepts:

- Backup status
- Last successful backup
- Scheduled export status
- Data export requests
- Restore requests/workflow if platform supports it

---

#### 41. Backup Dashboard

KPI:

- Last Successful Backup
- Next Scheduled
- Backup Health
- Failed Backup Jobs
- Data Export Requests

Table:

- Backup/Export ID
- Type
- Requested By
- Started
- Completed
- Size if available
- Status
- Action

Large exports run via **Trigger.dev**.

---

#### 42. Data Export Security

Exports require permission.

Possible:

```
data.export
```

For sensitive exports:

- audit request
- reason
- requested by
- timestamp
- scope
- expiration

Generated download links should be short-lived.

---

#### 43. Security

System Administrator handles delegated security configuration.

###### KPI

- MFA Compliance
- Locked Accounts
- Failed Logins
- Suspicious Events
- Admin Accounts
- Security Issues

---

#### 44. MFA

Mandatory according to our policy for privileged users such as:

- Client Admin
- System Administrator
- GM
- Business Owner
- Super Admin
- other sensitive/all-branch users

Use app-based TOTP.

System Admin can:

- View MFA status
- Require MFA where permitted
- Reset MFA through controlled workflow

They cannot view MFA secret values.

---

#### 45. Session / Login Security

Show:

- User
- Last Login
- Active Session count if supported
- Device/browser summary
- Failed logins
- Locked status

Actions permission-based:

- Revoke Sessions
- Lock User
- Unlock User
- Force Password Reset

All audited.

---

#### 46. Security Configuration

Depending on Client Admin delegation:

- MFA enforcement
- Password policy
- Session timeout
- Allowed login restrictions
- privileged-role controls

Platform-global security remains Super Admin territory.

---

#### 47. Reports

System Admin reports should be **technical/admin reports**, not GM Sales analytics.

Reports:

- User Activity
- Login Activity
- User Access by Branch
- Role/Permission Audit
- Integration Health
- Integration Errors
- Automation Runs
- Failed Jobs
- Template Usage
- Alert History
- AI Usage
- Storage Usage
- Data Export History
- Security Events
- Audit Export

---

#### 48. Reports Charts

Depending on report:

**Apache ECharts Line**

events over time.

**Apache ECharts Bar**

errors/usages by service or branch.

**Apache ECharts Donut**

status distributions.

Do not add charts where a table is clearer.

---

#### 49. Page-Local Search

Every list uses local search only.

Examples:

Users:

```
Name / Email / Phone / Employee ID
```

Integrations:

```
Provider / Connection Name
```

Audit:

```
User / Resource / Action
```

Master Data:

```
Name / Code
```

Do not make these searches query the entire CRM.

---

#### 50. Search Performance

Use approximately:

**300ms debounce**

Server-side search.

Use B-tree indexes for:

- tenant
- branch
- user
- role
- status
- dates
- provider
- event type

Use PostgreSQL `pg_trgm + GIN` only for useful fuzzy text fields.

---

#### 51. Pagination

All large tables:

**25 rows default**

Options:

**25 / 50 / 100**

Server-side pagination.

---

#### 52. Virtualization

Use **TanStack Virtual** only where it helps:

- Long permission matrix
- Long audit datasets
- Integration logs
- Long template lists
- Large user selectors

Don't virtualize every small paginated table.

---

#### 53. TanStack Query

Use for all server state.

Defaults:

staleTime = 60 seconds

gcTime = 30 minutes

refetchOnWindowFocus = false

refetchOnReconnect = true



Manual refresh:

**Maximum 3 refreshes/minute/user/page-resource**

---

#### 54. Query Invalidation

Example:

Changing User scope:

invalidate:

**Users + specific User Detail**

Do not refresh:

Integrations, Audit page, Master Data, Dashboard unnecessarily.

Mutations invalidate only affected query keys.

---

#### 55. Zustand

Use only for:

- sidebar
- open sheets/dialogs
- selected filters
- wizard progress
- temporary UI selections

Do not use Zustand as database/server-state storage.

---

#### 56. IndexedDB

Persist selected non-sensitive cached data.

Never store client-side:

- integration secrets
- MFA secrets
- provider credentials
- private recordings
- sensitive exports
- permanent signed URLs
- raw authentication information

---

#### 57. Trigger.dev

Use for:

- Provider sync
- Integration retries
- Automation execution
- Scheduled alerts
- Backup/export jobs
- Large reports
- AI jobs
- SLA checks
- Notification jobs

Not required for ordinary CRUD.

---

#### 58. Provider Secrets

All credentials:

**Server-side only**

Frontend shows:

```
••••••••
```

Actions:

**Replace Credential**

not:

**View Secret**

Use secure secret storage/encryption.

---

#### 59. Supabase RLS

System Admin remains tenant-isolated.

Every query checks:

**tenant + permission + branch/data scope**

If System Admin has only Branch A:

the database must prevent them from accessing Branch B even if they manually modify a URL/request.

---

#### 60. System Admin vs Client Admin

###### Client Admin

Business/configuration authority:

- creates dealership structure
- sets module access
- controls business rules
- creates/controls admin users
- final tenant-side authority

###### System Administrator

Delegated technical administrator:

- users/access
- permissions
- master data
- integrations
- automation
- templates
- alerts
- technical monitoring
- security
- backups
- audit

System Administrator does not replace Client Admin.

---

#### 61. System Admin vs Super Admin

###### System Administrator

Works **inside one dealership tenant**.

Even when assigned `ALL_BRANCHES`, it means:

**all branches of that dealership only.**

###### Super Admin

Works at the **Go Digital Marketing platform level** across dealership tenants.

That distinction is critical.

---

#### 62. Optional Operational Access

If Client Admin wants the System Admin to inspect an operational module for troubleshooting:

Example:

```
inventory.view = true
```

Then Inventory can appear.

But System Admin role itself does not automatically include:

- Finance processing
- Insurance processing
- RTO processing
- Delivery processing
- Lead selling
- Test drives
- quotation creation

---

#### 63. Final System Administrator Permission Summary

| **Capability**                   | **System Admin**   |
| -------------------------------- | ------------------ |
| Admin Dashboard                  | ✅                  |
| View users                       | ✅ delegated        |
| Create users                     | Optional           |
| Edit users                       | Optional           |
| Manage allowed roles             | Optional           |
| Manage branch access             | ✅ within scope     |
| Manage master data               | ✅ permission based |
| Configure integrations           | ✅                  |
| See provider secrets             | ❌                  |
| Replace credentials              | ✅                  |
| Field mapping                    | ✅                  |
| Run connection tests             | ✅                  |
| Automation rules                 | ✅                  |
| Templates                        | ✅                  |
| Alerts                           | ✅                  |
| System health                    | ✅                  |
| Audit Logs                       | ✅                  |
| Backup/export management         | ✅ permission based |
| Security management              | ✅ delegated        |
| View Sales operational data      | ❌ by default       |
| Finance/RTO/Insurance processing | ❌                  |
| Create Client Admin              | ❌ by default       |
| Create Business Owner            | ❌                  |
| Create Super Admin               | ❌                  |
| Access another dealership        | ❌                  |

---

#### 64. Final System Administrator Flow

CLIENT ADMIN

      ↓

Creates / Configures

SYSTEM ADMINISTRATOR

      ↓

Role + Permissions + Data Scope

      ↓

────────────────────────────

TECHNICAL CRM ADMINISTRATION

────────────────────────────

      ↓

Users & Access

Roles & Permissions

Branches & Access

Master Data

Integrations

Automations

Templates

Alerts

System Health

Audit

Backup/Data

Security

Reports



And always:

**System Administrator authority ≤ delegated Client Admin authority**

and:

**System Administrator scope ≤ assigned dealership/branch scope**

This is the version I would **freeze as the final System Administrator PRD**.

So after this, the major roles left are **Business Owner**, then **Super Admin last**.


### 54.9 Business Owner — detailed page PRD

#### BUSINESS OWNER — FINAL WEB PRD

##### 1. Business Owner Purpose

Business Owner is the **executive owner of one dealership organization**.

Their main job is:

**View the complete business → monitor performance → monitor operations → manage Client Admins → maintain company/compliance information → monitor credits/usage → approve Super Admin support access when needed.**

Business Owner should **not** normally:

- work leads
- make calls
- assign Telecallers
- process Finance
- process RTO
- edit Inventory
- configure every CRM setting
- create Sales/Operational users

Those jobs belong to Client Admin and departmental roles.

Business Owner is primarily **executive + administrative oversight**.

---

#### 2. Final Business Owner Sidebar

1. **Dashboard**
2. **Sales Overview**
3. **Showroom Performance**
4. **Operations Overview**
5. **Bookings & Delivery**
6. **Targets & Performance**
7. **AI Business Summary**
8. **Reports**
9. **Client Admins**
10. **Company & Compliance**
11. **Credits & Usage**
12. **Support & Maintenance**
13. **Security & Access**

Contextual, not sidebar:

**Customer 360 | Showroom Detail | Booking Detail | Operational Case Summary | Client Admin Detail | Credit Transaction Detail | Support Session Detail | Compliance Document Detail**

Business Owner = **Web only for MVP**.

---

#### 3. Business Owner Scope

Business Owner normally gets:

**ORGANIZATION scope**

meaning all authorized branches/showrooms belonging to that dealership organization.

So Business Owner gets an executive view across the complete dealership rather than becoming another branch manager.

Multiple Business Owner accounts can technically exist if required, but all are high-privilege accounts with mandatory MFA.

---

#### 4. New Dealership Creation Flow

This is the first-time onboarding flow.

BUSINESS OWNER MEETS / CONTACTS

GO DIGITAL MARKETING

        ↓

SUPER ADMIN

Creates Dealership Organization

        ↓

Creates Initial Business Owner

        ↓

Invitation / Temporary Access Email

        ↓

Business Owner First Login

        ↓

Forced Password Setup/Change

        ↓

Mandatory MFA

        ↓

Company Onboarding

        ↓

Documents Uploaded

        ↓

SUBMIT FOR REVIEW

        ↓

UNDER REVIEW

        ↓

SUPER ADMIN REVIEW

     ↙            ↘

Approve        Changes / Reject

   ↓

ACTIVE




---

#### 5. Initial Business Owner Credentials

Super Admin enters:

- Owner Full Name
- Business Email
- Phone
- Dealership Organization Name

Then CRM creates the account.

###### Security rule

Super Admin must **never know or retrieve the Business Owner's permanent password**.

Best implementation:

**system-generated temporary one-time credential / secure setup invitation**

sent directly by email.

If using temporary password:

- generated automatically
- short-lived
- one-time
- force password change
- cannot be viewed again by Super Admin

Then Business Owner creates their own permanent password.

---

#### 6. First Login

Business Owner enters temporary credentials/setup flow.

Immediately require:

###### Step 1

**Create New Password**

###### Step 2

**Enable MFA**

Use TOTP/app-based MFA.

###### Step 3

**Start Organization Onboarding**

They cannot access the normal CRM yet.

---

#### 7. Company Onboarding

Use a clean shadcn stepper/wizard.

###### Business Information

- Legal Business Name
- Trading/Display Name
- Business Type
- GSTIN where applicable
- PAN / Tax information where applicable
- Website
- Primary Email
- Primary Phone

###### Registered Address

- Address
- City
- State
- PIN
- Country

###### Authorized Contact

- Name
- Designation
- Email
- Phone

###### Dealership Information

- Brand/OEM
- Dealer Code if applicable
- Number of branches
- Main showroom
- Business operating information

###### Billing Information

- Billing contact
- Billing email
- Billing address if different

---

#### 8. Compliance Documents

Required documents must be configurable by Super Admin.

Examples can include:

- GST certificate
- Business registration/incorporation document
- PAN/tax document
- Address proof
- Authorized signatory proof
- Dealer/OEM authorization where applicable

Do not hard-code that every document is legally mandatory for every customer.

Use:

**shadcn Card + File Upload + Badge**

Statuses:

**Missing | Uploaded | Under Review | Accepted | Changes Required**

Files go to **private Tigris Data object storage**.

---

#### 9. Submit for Review

After required information is complete:

**Submit for Review**

Tenant state becomes:

```
UNDER_REVIEW
```

Normal CRM access remains disabled.

---

#### 10. Under Review Screen

This should be very simple.

Large status:

###### Application Under Review

Message:

> Your dealership information has been submitted successfully. Our team is reviewing the details and documents. We'll get back to you shortly.

Show:

- Organization
- Submitted Date
- Review Status
- Required Changes if any
- Support Contact

Do **not** show the normal CRM sidebar while under review.

---

#### 11. Super Admin Review Result

Super Admin can:

###### Approve

Tenant:

```
ACTIVE
```

Business Owner enters normal CRM.

###### Request Changes

Tenant:

```
CHANGES_REQUIRED
```

Business Owner can edit the requested sections and resubmit.

###### Suspend

Access blocked but data preserved.

###### Close / Delete

Use **soft delete only**.

Never immediately hard-delete.

---

#### 12. Soft Delete Architecture

Use fields conceptually like:

```
deleted_at
deleted_by
deletion_reason
purge_after
```

When soft deleted:

- login blocked
- organization hidden from active client lists
- data preserved
- account can potentially be restored before purge
- email identity should not simply be physically removed immediately

Later:

**scheduled purge job / cron-style retention job**

permanently removes eligible data after the configured retention period and platform policy.

Use **Trigger.dev scheduled job** or equivalent server-side scheduled purge process.

Every deletion/purge action is audited.

---

#### 13. After Approval

After Super Admin approves:

Business Owner Dashboard opens.

Business Owner can then create their first:

###### Client Admin

From that point:

**Client Admin handles normal dealership setup**

including:

Branches → Teams → Users → Roles → Integrations → Modules → CRM Configuration.

This keeps Business Owner simple.

---

#### 14. Dashboard

Purpose:

> How is my dealership business performing right now?

Use **shadcn Cards + Apache ECharts**.

###### KPI Cards

- Total Leads
- Qualified Leads
- Test Drives
- Quotations
- Bookings
- Delivered Vehicles
- Sales Conversion %
- Target Achievement %
- Booking / Sales Value
- Active Showrooms
- Operational Delays
- AI Credits Remaining

---

#### 15. Executive Sales Funnel

Use **Apache ECharts Funnel**:

**Leads → Contacted → Qualified → Test Drive → Quotation → Booking → Delivered**

Click any stage to open the filtered executive view.

---

#### 16. Sales Trend

Use **Apache ECharts Line**:

- Leads
- Bookings
- Deliveries

Time range:

**7 Days | 30 Days | Month | Quarter | Custom**

---

#### 17. Showroom Performance

Use **Apache ECharts Bar**:

**Target vs Actual by Showroom**

Dashboard table:

| **Showroom** | **Leads** | **Bookings** | **Delivered** | **Conversion** | **Target** |
| ------------ | --------- | ------------ | ------------- | -------------- | ---------- |

Click showroom → Showroom Detail.

---

#### 18. Operational Health

Use simple cards rather than too many graphs.

Show:

- Inventory Allocation Pending
- Finance Pending
- Insurance Pending
- RTO Pending
- Delivery Pending
- SLA Risk

Use one **ECharts Donut** for overall booking operational status if useful.

---

#### 19. Sales Overview

Business Owner gets organization-wide sales analysis.

Default = **read-only**.

###### KPI

- Leads
- Qualified
- Test Drives
- Quotations
- Bookings
- Delivered
- Conversion
- Lost %

###### Filters

- Date
- Showroom
- Model
- Lead Source

###### ECharts Funnel

**Lead → Qualified → Test Drive → Quote → Booking**

###### ECharts Bar

**Bookings by Model**

###### ECharts Bar

**Bookings by Lead Source**

###### Table

**Showroom | Leads | Qualified | Test Drives | Quotations | Bookings | Delivered | Conversion**

---

#### 20. Customer Drill-down

Business Owner does not need a standalone customer database sidebar.

From a Lead/Booking/Report they can open:

###### Customer 360 — Read-only executive view

Show:

- Customer
- Leads
- Vehicles
- Calls
- Appointments
- Test Drives
- Quotations
- Bookings
- Finance
- Insurance
- RTO
- Delivery
- Timeline

This gives the Business Owner the full story of one customer when needed.

---

#### 21. Showroom Performance

Shows all showrooms.

###### KPI

- Active Showrooms
- Best Performing
- Below Target
- Highest Conversion
- Highest Lost %
- Highest Operational Delay

###### ECharts Bar

**Bookings by Showroom**

###### ECharts Bar

**Target vs Actual**

###### ECharts Line

**Showroom Sales Trend**

###### Table

**Showroom | GM | Manager | Leads | Test Drives | Quotes | Bookings | Deliveries | Conversion | Target %**

---

#### 22. Operations Overview

Keep one executive operational page instead of giving Business Owner seven operational sidebars.

Tabs:

**Inventory | Finance | Insurance | RTO | Exchange | Delivery**

Business Owner = read-only.

###### Inventory

- Available Stock
- Reserved
- Allocated
- Ageing
- In Transit

###### Finance

- Pending
- Approved
- Rejected
- Disbursement Pending

###### Insurance

- Documents Pending
- Policy Pending
- Ready

###### RTO

- Documents Pending
- Submitted
- Registration Pending
- Completed

###### Exchange

- Evaluation Pending
- Accepted
- Rejected

###### Delivery

- Upcoming
- Blocked
- Ready
- Delivered

---

#### 23. Bookings & Delivery

This is the owner's high-level post-sale monitoring page.

###### KPI

- New Bookings
- Confirmed
- Vehicle Pending
- Finance Pending
- Insurance Pending
- RTO Pending
- Ready for Delivery
- Delivered

###### Table

**Booking | Customer | Showroom | Sales Consultant | Vehicle | Allocation | Finance | Insurance | RTO | Delivery | Expected Delivery | Overall Status**

Example:

```
BK-1042
```

Vehicle ✅
Finance ✅
Insurance ✅
RTO ⏳
Delivery Waiting

Business Owner immediately sees where the booking is stuck.

---

#### 24. Targets & Performance

Business Owner primarily monitors targets.

###### KPI

- Overall Target
- Achieved
- Remaining
- Forecast
- Achievement %
- Days Remaining

###### ECharts Bar

**Target vs Actual by Showroom**

###### ECharts Line

**Achievement Trend**

###### Table

**Showroom | Target | Actual | Forecast | Achievement % | Status**

GM/Showroom hierarchy handles day-to-day target distribution.

---

#### 25. AI Business Summary

This should be one of the strongest Business Owner features.

Button:

###### Generate / Refresh Business Summary

AI analyses permitted aggregated CRM information.

Possible output:

###### Business Overview

"Bookings increased 12% compared with the previous period."

###### Opportunities

"Elevate enquiries are strong in Whitefield but stock availability is low."

###### Risks

"RTO delays are affecting seven expected deliveries."

###### Sales Insight

"Google Ads has a higher booking conversion than Facebook this month."

###### Recommended Actions

"Review Whitefield stock allocation and RTO backlog."

AI must not silently change CRM data.

---

#### 26. AI Business Summary Credits

Generating/refreshing a summary consumes dealership AI credits.

Before generation where practical show:

**Estimated Credit Usage**

Existing saved summary can be viewed without consuming credits again.

---

#### 27. Reports

Executive reports:

- Overall Sales
- Showroom Comparison
- Lead Source Performance
- Model Performance
- Sales Conversion
- Target Achievement
- Booking Pipeline
- Delivery Performance
- Operational Delay
- Lost Leads
- Inventory Overview
- AI Usage
- Business Summary

Heavy exports use Trigger.dev.

---

#### 28. Client Admins

Business Owner can create/manage **Client Admin users**.

They do not normally create every Sales/Operational employee.

###### KPI

- Total Client Admins
- Active
- MFA Enabled
- Last Login
- Locked

###### Table

**Admin | Email | Phone | Scope | Branches | MFA | Last Login | Status | Action**

---

#### 29. Create Client Admin

Fields:

- Full Name
- Email
- Phone
- Employee ID optional

Scope:

**ONE\_BRANCH**

or:

**SELECTED\_BRANCHES**

or:

**ALL\_BRANCHES**

Security:

**MFA Required = ON**

Business Owner presses:

**Create & Send Invitation**

CRM sends setup credentials/invite directly to the new Client Admin.

Business Owner does not see their permanent password.

---

#### 30. Client Admin Actions

Business Owner can:

- Create Client Admin
- Edit allowed profile information
- Change branch scope
- Disable
- Re-enable
- Resend invitation
- Trigger password-reset email
- View MFA status
- View last login

Every action audited.

Normal Sales/Operational users are then created by Client Admin.

---

#### 31. Company & Compliance

After activation this page stores the official dealership organization profile.

Sections:

- Company Information
- Registered Address
- Authorized Contacts
- Tax/GST Information
- Dealer Information
- Billing Information
- Documents
- Verification Status

Business Owner can update normal fields.

For sensitive legal/company identity changes, optionally require Super Admin re-review.

---

#### 32. Credits & Usage

Super Admin manages platform credit allocation.

Business Owner sees:

###### KPI

- Credits Allocated
- Used
- Remaining
- Used Today
- Used This Month

###### ECharts Line

Credit usage over time.

###### ECharts Donut

Usage by:

- Transcription
- AI Summary
- Field Extraction
- AI Image
- Business Summary
- Other

###### Table

**Feature | Usage Count | Credits Used | Period**

---

#### 33. Numeric Credit Allocation

Super Admin can add an exact amount.

Example:

**Add AI Credits:** **`50000`**

Transaction:

+50,000

Allocated by Super Admin

Reason: Monthly package

Date/time



Business Owner sees the transaction but cannot alter it.

Keep a credit ledger rather than simply overwriting `balance`.

Concept:

**Previous Balance + Credit Transaction - Usage Transactions = Current Balance**

---

#### 34. Separate Tracking Credits

If you monetize live GPS separately:

keep:

**AI Credits**

and:

**Tracking Usage/Credits**

separate.

Do not mix them.

---

#### 35. Support & Maintenance

This implements your Super Admin support-session idea.

Do **not** use invisible impersonation.

Use:

###### Support Access Session

Super Admin sends:

**Request Support Access**

to:

- Business Owner
- or authorized Client Admin

Request shows:

- Requested By
- Purpose
- Requested Scope
- Requested Duration
- Actions they may perform

Maximum:

**1 hour**

---

#### 36. Support Request

Example:

> Go Digital Marketing Support is requesting temporary administrative access to configure your Meta and IVR integrations.

Buttons:

**Accept Support Session**

**Decline**

Nothing starts until accepted.

---

#### 37. After Acceptance

Tenant enters:

###### SUPPORT MAINTENANCE MODE

Normal users:

**Telecaller, Sales Consultant, Team Manager, Showroom Manager, GM, Finance, Insurance, RTO, etc.**

see:

> CRM is temporarily under maintenance. Please try again shortly.

Normal application actions are blocked.

---

#### 38. Owner/Admin During Maintenance

Business Owner / authorized Client Admin retain only a **Support Session Control screen**.

Show:

- Support user
- Started
- Purpose
- Scope
- Time Remaining
- Actions being logged
- End Session

They do not continue normal CRM operations during the maintenance window.

This avoids users changing configuration while Super Admin is fixing it.

---

#### 39. Super Admin Support Context

Super Admin enters the dealership through a clearly marked banner:

###### Support Session — Dealership XYZ

They may perform only the accepted support scope.

Examples:

- integration configuration
- provider connection troubleshooting
- field mapping
- CRM configuration
- branch/system configuration
- technical fixes permitted by the session

They cannot reveal:

- user passwords
- MFA secrets
- stored provider secrets

They may **replace/reconfigure** credentials through secure forms, but not display existing plaintext secrets.

---

#### 40. Support Session Expiry

Maximum:

**1 hour**

Automatically ends at expiration.

Can end earlier by:

- Super Admin
- Business Owner
- Authorized Client Admin

When ended:

```
SUPPORT_MAINTENANCE → ACTIVE
```

normal users regain CRM access.

---

#### 41. Support Session Audit

Store:

- Session ID
- Tenant
- Requested By
- Approved By
- Purpose
- Scope
- Start Time
- End Time
- Expiration
- Every resource changed
- Before/after where appropriate
- IP/session information
- Termination reason

This audit cannot be modified by the support user.

---

#### 42. Security & Access

Business Owner gets a small security page.

###### KPI

- Client Admin Accounts
- MFA Compliance
- Failed Owner/Admin Logins
- Active Support Session
- Security Warnings

Business Owner can:

- change own password
- manage own MFA
- view own sessions
- revoke own sessions
- view Client Admin MFA status
- request/reset Client Admin access through secure flow

---

#### 43. MFA

Mandatory for Business Owner.

Use TOTP.

Do not expose TOTP secret after setup.

Recovery/reset must be controlled and audited.

---

#### 44. Business Owner Notifications

Important notifications only:

- Client Admin created
- suspicious login
- support access requested
- support session started/ended
- organization compliance change requested
- AI credits low
- major integration failure
- major business escalation
- dealership suspended/account issue

Do not spam Business Owner with every sales follow-up.

---

#### 45. UI Rules

All pages use:

**Next.js + TypeScript + Tailwind + shadcn/ui**

Core components:

**Card | Table | Badge | Button | Tabs | Sheet | Dialog | AlertDialog | Progress | Select | Command | Tooltip | Skeleton | ScrollArea | Form**

Charts:

**Apache ECharts only**

Tables:

**TanStack Table + shadcn Table**

---

#### 46. Table/Search Standard

Large tables:

**server-side pagination**

Default:

**25**

Options:

**25 / 50 / 100**

Page-local search only.

Approximately:

**300ms debounce**

Use indexed PostgreSQL queries.

Use `pg_trgm + GIN` where fuzzy name search is genuinely needed.

---

#### 47. Query/Caching

Use **TanStack Query**.

staleTime = 60 seconds

gcTime = 30 minutes

refetchOnWindowFocus = false

refetchOnReconnect = true



Manual Refresh:

**Maximum 3/minute/user/page-resource**

Use Zustand only for lightweight UI state.

Selected non-sensitive web cache:

**IndexedDB**

---

#### 48. Data Security

Use Supabase PostgreSQL + RLS.

Business Owner can access only their dealership tenant.

Customer/business documents:

**Private Tigris Data object storage**

use short-lived signed URLs.

No cross-tenant access.

---

#### 49. Business Owner Permission Summary

| **Capability**                   | **Business Owner** |
| -------------------------------- | ------------------ |
| Executive Dashboard              | ✅                  |
| Organization-wide Sales Overview | ✅ Read-only        |
| Showroom Performance             | ✅                  |
| Operational Overview             | ✅ Read-only        |
| Booking/Delivery Overview        | ✅                  |
| Customer 360 Drill-down          | ✅ Read-only        |
| Target Monitoring                | ✅                  |
| AI Business Summary              | ✅                  |
| Reports                          | ✅                  |
| Create Client Admin              | ✅                  |
| Manage lower sales users         | ❌ normally         |
| Configure integrations           | ❌ normally         |
| Process Finance/RTO/etc.         | ❌                  |
| Edit Inventory                   | ❌                  |
| View AI Credits                  | ✅                  |
| Add platform credits             | ❌                  |
| Company/Compliance Profile       | ✅                  |
| Approve Support Access           | ✅                  |
| End Support Session              | ✅                  |
| Manage own security/MFA          | ✅                  |
| Create Super Admin               | ❌                  |

---

#### 50. Final Business Owner Lifecycle

SUPER ADMIN

    ↓

CREATE DEALERSHIP ORGANIZATION

    ↓

CREATE BUSINESS OWNER

    ↓

EMAIL INVITATION / TEMP ACCESS

    ↓

FIRST LOGIN

    ↓

PASSWORD CHANGE

    ↓

MANDATORY MFA

    ↓

COMPANY ONBOARDING

    ↓

DOCUMENT UPLOAD

    ↓

SUBMIT

    ↓

UNDER REVIEW

    ↓

SUPER ADMIN APPROVAL

    ↓

ACTIVE DEALERSHIP

    ↓

BUSINESS OWNER

    ↓

CREATE CLIENT ADMIN

    ↓

CLIENT ADMIN CONFIGURES CRM

    ↓

BUSINESS OWNER MONITORS BUSINESS



And when Go Digital Marketing needs temporary technical access:

SUPER ADMIN

    ↓

REQUEST SUPPORT ACCESS

    ↓

BUSINESS OWNER / CLIENT ADMIN ACCEPTS

    ↓

TENANT MAINTENANCE MODE

    ↓

MAX 1-HOUR SUPPORT SESSION

    ↓

FULL AUDIT

    ↓

END / AUTO EXPIRE

    ↓

CRM ACTIVE AGAIN



This is the **final Business Owner PRD** I would freeze. The only major platform role left after this is **Super Admin**, and doing that last is correct because we now know everything Super Admin needs to create, approve, monitor, support and bill.


### 54.10 Super Admin — detailed page PRD

##### SUPER ADMIN — FINAL WEB PRD

##### 1. Role Purpose

Super Admin manages the **entire Go Digital Marketing SaaS platform**, not one dealership.

Super Admin responsibilities:

- Create dealership organizations/tenants
- Create initial Business Owner
- Review and approve dealership onboarding
- Manage tenant status
- Configure plans/features/modules
- Allocate AI credits
- Allocate tracking/usage credits if used
- Monitor usage
- Monitor integrations/providers
- Monitor platform/system health
- Handle support-access sessions
- Handle security/audit
- Manage retention/soft deletion
- Manage platform configuration
- View platform reports

Super Admin does **not** normally work dealership leads, quotations, bookings, RTO cases, etc.

---

#### 2. Final Super Admin Sidebar

1. **Dashboard**
2. **Dealerships**
3. **Onboarding Reviews**
4. **Business Owners**
5. **Plans & Features**
6. **Modules & Entitlements**
7. **Credits & Usage**
8. **Integrations & Providers**
9. **Support Sessions**
10. **Platform Health**
11. **Users & Access**
12. **Security**
13. **Audit Logs**
14. **Data Retention & Deletion**
15. **Platform Settings**
16. **Reports**

Contextual pages:

- Dealership Detail
- Onboarding Review Detail
- Business Owner Detail
- Credit Ledger Detail
- Provider Detail
- Support Session Detail
- Security Event Detail
- Audit Event Detail
- Deletion/Purge Detail

Super Admin = **Web only**.

---

#### 3. Terminology

User-facing term:

**Dealership Organization**

Backend:

**Tenant**

Do not call dealership clients “agencies” in the CRM UI.

Example:

```
Go Honda Bengaluru
```

is a Dealership Organization / Tenant.

---

#### 4. Platform Hierarchy

GO DIGITAL MARKETING PLATFORM

        ↓

SUPER ADMIN

        ↓

DEALERSHIP ORGANIZATION / TENANT

        ↓

BUSINESS OWNER

        ↓

CLIENT ADMIN

        ↓

GM / SYSTEM ADMIN / SHOWROOM MANAGER

        ↓

TEAM MANAGER

        ↓

TELECALLER + SALES CONSULTANT

        ↓

OPERATIONAL DEPARTMENTS



Super Admin exists **outside the dealership hierarchy**.

---

#### 5. Super Admin Dashboard

Purpose:

> What is happening across the entire SaaS platform?

Use **shadcn Card + Apache ECharts**.

###### KPI Cards

- Total Dealerships
- Active Dealerships
- Under Review
- Suspended
- Total Platform Users
- Active Users
- Leads Today
- Bookings This Month
- AI Credits Consumed
- Active Integrations
- Provider Errors
- Active Support Sessions
- Security Alerts

---

#### 6. Tenant Growth Chart

Use **Apache ECharts Line**.

Series:

- New Dealerships
- Activated Dealerships
- Active Users

Range:

- 30 Days
- 90 Days
- 12 Months

---

#### 7. Platform Usage Chart

Use **Apache ECharts Line**.

Series:

- Leads Created
- API Events
- AI Requests
- Background Jobs

This is platform health/usage monitoring, not dealership sales analysis.

---

#### 8. Dealership Status Distribution

Use **Apache ECharts Donut**:

- Active
- Under Review
- Changes Required
- Suspended
- Soft Deleted

---

#### 9. Dashboard Requires Attention

Show:

- Dealership onboarding waiting for review
- Failed provider connection
- High integration error rate
- AI credits exhausted
- Repeated background job failures
- Support request pending
- Suspicious security event
- Tenant storage threshold warning
- Scheduled purge approaching
- Failed scheduled backup/export if supported

Each card deep-links to the correct page.

---

#### 10. Dealerships

This is the main tenant-management page.

###### KPI

- Total
- Active
- Under Review
- Suspended
- Soft Deleted

###### Filters

- Search
- Status
- Plan
- State/Region
- Created Date
- Module Set
- Usage Level

---

#### 11. Dealership Table

Columns:

- Organization Name
- Tenant ID
- Business Owner
- Primary Email
- Branches
- Users
- Plan
- Modules
- AI Balance
- Status
- Created
- Last Activity
- Action

Actions:

- Open
- Edit Platform Settings
- Suspend
- Restore
- Soft Delete
- Request Support Access

---

#### 12. Create Dealership

Super Admin presses:

**+ Create Dealership**

Capture:

###### Organization

- Legal/Display Name
- Primary Email
- Primary Phone
- Country
- State
- City
- Initial Plan
- Initial Modules

###### Initial Business Owner

- Full Name
- Email
- Phone

###### Optional

- Dealer/OEM name
- Dealer code
- Sales contact
- Notes

Then:

**Create Organization & Send Owner Invite**

---

#### 13. Initial Business Owner Account

Super Admin must **not create or know the permanent password**.

Preferred flow:

**Generate secure setup invitation / one-time temporary credential**

Email sent directly to Business Owner.

First login requires:

1. Set/change password
2. Mandatory MFA
3. Complete dealership onboarding

Super Admin never sees:

- final password
- password hash
- MFA TOTP secret

---

#### 14. Dealership Initial State

New tenant:

```
ONBOARDING
```

After Business Owner submits company data:

```
UNDER_REVIEW
```

Normal CRM modules remain blocked until approval.

---

#### 15. Onboarding Reviews

Sidebar page:

**Onboarding Reviews**

Tabs:

- Pending Review
- Changes Requested
- Approved
- Rejected

###### Table

- Organization
- Business Owner
- Submitted Date
- GST/Tax Status
- Documents
- Missing Items
- Reviewer
- Status
- Action

---

#### 16. Onboarding Review Detail

Show:

###### Organization Information

- Legal Name
- Display Name
- GST/tax
- PAN/tax details if applicable
- Address
- Website
- Contact details

###### Owner / Authorized Contact

- Name
- Email
- Phone
- Designation

###### Dealer Details

- OEM
- Dealer code
- Branch count

###### Documents

- GST certificate
- business registration
- tax docs
- dealer authorization
- address proof
- authorized signatory docs

Required documents remain configurable.

---

#### 17. Onboarding Review Actions

Super Admin can:

###### Approve

Tenant becomes:

```
ACTIVE
```

###### Request Changes

Tenant:

```
CHANGES_REQUIRED
```

Business Owner edits requested sections and resubmits.

###### Reject

Onboarding rejected but data preserved.

###### Suspend

Blocks access.

###### Soft Delete

Marks tenant for eventual deletion.

Every action requires reason and is audited.

---

#### 18. Under Review Experience

Business Owner sees only:

###### Application Under Review

> Your dealership information has been submitted successfully. Our team is reviewing your information and documents. We'll get back to you shortly.

No normal CRM sidebar.

---

#### 19. Business Owners

Super Admin can view Business Owner accounts across tenants.

###### Table

- Owner Name
- Dealership
- Email
- Phone
- MFA
- Last Login
- Account Status
- Tenant Status
- Action

Actions:

- View
- Resend Invite
- Trigger Password Reset
- Lock/Unlock
- Suspend tenant if authorized
- Request Support Access

Never expose passwords.

---

#### 20. Plans & Features

Super Admin controls platform commercial/feature bundles.

Example plans:

- Starter
- Growth
- Enterprise
- Custom

Do not hard-code pricing logic deeply into the CRM.

###### Plan configuration

- Plan Name
- Max Users
- Max Branches
- Included Modules
- Storage Limit
- AI Credit Allowance
- Integration Limits
- Report Limits
- Support Level
- Status

---

#### 21. Feature Entitlements

Feature toggles may include:

- Sales CRM
- Finance
- Insurance
- RTO
- Inventory
- Exchange
- Delivery
- Customer Relationship
- Digital Marketing
- AI Transcription
- AI Summary
- AI Image
- Live Test Drive Tracking
- Advanced Reports
- Automation Rules
- API Access

---

#### 22. Modules & Entitlements

This page controls tenant-level module availability.

Example:

**Dealership A**

- Sales ✅
- Inventory ✅
- Finance ✅
- Insurance ✅
- RTO ✅
- Delivery ✅
- Digital Marketing ❌

Client Admin can control access **inside enabled modules**, but only Super Admin can enable a platform module if the tenant's plan/entitlement requires Super Admin control.

---

#### 23. Entitlement Table

Columns:

- Dealership
- Plan
- Module
- Enabled
- Limit
- Current Usage
- Override
- Updated By
- Action

Use `shadcn Table + TanStack Table`.

---

#### 24. Credits & Usage

This is important.

Keep separate wallets:

###### AI Credits

For:

- transcription
- AI summary
- field extraction
- AI business summary
- AI image/content
- other AI features

###### Tracking Credits

Optional, for:

- Real-Time Boost
- premium live GPS usage

Do not mix the balances.

---

#### 25. Credit Ledger

Never simply overwrite a balance.

Use an append-only ledger.

Example:

+50,000 AI Credits

Reason: Monthly Allocation



-120 Credits

Feature: Call Transcription



-45 Credits

Feature: AI Summary



Balance derives from ledger transactions.

---

#### 26. Add Credits

Super Admin selects dealership.

Fields:

- Credit Type
- Amount
- Reason
- Reference
- Expiry if applicable

Example:

**Add AI Credits**

```
50,000
```

Then:

**Confirm Allocation**

Store:

- before balance
- transaction
- after balance
- allocated by
- timestamp
- reason

---

#### 27. Credits Dashboard

###### KPI

- Total AI Credits Allocated
- AI Credits Used
- Remaining Across Tenants
- Usage Today
- Tracking Usage
- Tenants Low on Credits

###### ECharts Line

AI usage over time.

###### ECharts Donut

Usage by feature.

###### ECharts Bar

Top tenants by AI consumption.

---

#### 28. Tenant Credit Detail

Show:

- Allocated
- Used
- Remaining
- Last Allocation
- Usage Today
- Usage This Month

Table:

**Date | Type | Feature | Credit +/- | Balance | User/Source | Reference**

Business Owner sees tenant's own ledger read-only.

---

#### 29. Integrations & Providers

This is platform/provider-level monitoring.

Important distinction:

###### Client/System Admin

configure dealership-specific connections.

###### Super Admin

configures/monitors platform provider adapters and overall service health.

Providers may include:

- Brevo
- Meta/WhatsApp
- IVR providers
- AI providers
- Image AI
- Maps
- Voice AI
- SMS
- other adapters

---

#### 30. Provider Dashboard

###### KPI

- Active Providers
- Healthy
- Warning
- Failed
- API Errors Today
- Rate Limit Events

###### ECharts Donut

Provider Health.

###### ECharts Line

Success vs failure events.

---

#### 31. Provider Table

Columns:

- Provider
- Adapter
- Type
- Status
- Connected Tenants
- Requests Today
- Failures
- Last Error
- Action

Actions:

- Open
- Disable New Connections
- View Errors
- Update Platform Config
- Run Health Test

---

#### 32. Provider Secrets

Platform/provider credentials:

**server-side only**

UI:

```
••••••••
```

Action:

**Replace Credential**

Never:

**Reveal Existing Secret**

Super Admin also cannot reveal a dealership's stored provider secret during support.

---

#### 33. Provider Error Logs

Columns:

- Time
- Provider
- Tenant
- Connection
- Operation
- Error Type
- Retry Count
- Status
- Action

Use Trigger.dev for background retry jobs where appropriate.

---

#### 34. Support Sessions

This implements the temporary access flow.

No invisible impersonation.

Super Admin presses:

**Request Support Access**

Select:

- Dealership
- Purpose
- Requested Scope
- Requested Duration
- Required capabilities

Maximum:

**1 hour**

---

#### 35. Support Request Recipient

Send request to:

- Business Owner
- or authorized Client Admin

Request displays:

> Go Digital Marketing Support is requesting temporary access to configure/troubleshoot your CRM.

Show:

- Super Admin/support user
- purpose
- requested permissions
- duration

Actions:

**Accept | Decline**

---

#### 36. Before Acceptance

Nothing changes.

Super Admin cannot enter tenant support context.

---

#### 37. After Acceptance

Tenant enters:

```
SUPPORT_MAINTENANCE
```

Ordinary users:

- Telecaller
- Sales Consultant
- Team Manager
- Showroom Manager
- GM
- Operational Users

see:

###### CRM Under Maintenance

> This CRM is temporarily under maintenance. Please try again shortly.

Normal CRUD/actions are blocked.

---

#### 38. Owner/Admin Maintenance Screen

Business Owner / authorized Client Admin sees only:

- Support Session ID
- Requested By
- Purpose
- Start Time
- Expiry
- Time Remaining
- Approved Scope
- Recent Support Actions
- End Session

No normal CRM work during maintenance.

---

#### 39. Super Admin Support Context

Show prominent banner:

###### SUPPORT SESSION — [DEALERSHIP NAME]

Super Admin can only perform actions granted by the accepted support scope.

Examples:

- Integration configuration
- Field mapping
- Provider troubleshooting
- CRM settings
- Automation repair
- Branch configuration
- technical user-access troubleshooting

---

#### 40. Support Session Restrictions

Even during support Super Admin cannot reveal:

- permanent passwords
- password hashes
- MFA secrets
- provider secrets
- private authentication material

They may **replace** secrets securely, not view them.

---

#### 41. Support Session Expiry

Maximum:

**1 hour**

Can terminate earlier by:

- Super Admin
- Business Owner
- Authorized Client Admin

Automatically expires.

Then:

```
SUPPORT_MAINTENANCE → ACTIVE
```

Normal CRM access returns.

---

#### 42. Support Audit

Store:

- Session ID
- Tenant
- Requested By
- Approved By
- Purpose
- Scope
- Started At
- Expires At
- Ended At
- Ended By
- Every support action
- Before/after values where applicable
- Session/IP metadata
- termination reason

These logs are immutable from the support session.

---

#### 43. Platform Health

This gives Super Admin the highest-level technical view.

###### KPI

- API Health
- Database Health
- Realtime Health
- Storage Health
- Trigger.dev Job Health
- Integration Health
- Error Rate
- Queue Backlog
- Active Incidents

---

#### 44. Platform Health Charts

Use **Apache ECharts Line**:

- API Requests
- API Errors
- Background Job Success
- Background Job Failure

Use **Apache ECharts Bar**:

Errors by service/provider.

---

#### 45. System Health Services

Monitor:

- Authentication
- Supabase Database
- Tigris Data object storage
- Realtime
- Trigger.dev
- Email
- WhatsApp
- IVR
- AI
- Maps
- Lead Ingestion
- Scheduled Jobs

Do not expose sensitive infrastructure credentials in UI.

---

#### 46. Users & Access

This page is for **platform-level administrative users**, not normal dealership staff.

Possible:

- Super Admin
- Platform Support
- Platform Operations
- Billing Admin
- Read-only Audit/Admin role later

Normal dealership users remain under their tenant.

---

#### 47. Super Admin Creation

This should be highly restricted.

Do not allow any dealership role to create Super Admin.

Only an already authorized platform authority can create another platform admin.

Require:

- high-privilege permission
- MFA
- audit
- confirmation
- possibly dual approval later if needed

---

#### 48. Platform User Table

Columns:

- User
- Platform Role
- Email
- MFA
- Last Login
- Status
- Created By
- Action

Actions:

- View
- Disable
- Reset Access
- Change Platform Role

All audited.

---

#### 49. Security

Platform-wide security page.

###### KPI

- Platform Admins
- MFA Compliance
- Failed Privileged Logins
- Locked Accounts
- Suspicious Sessions
- Active Security Alerts

---

#### 50. Privileged MFA

Mandatory for:

- Super Admin
- Business Owner
- Client Admin
- System Administrator
- GM
- other high-privilege users

Use TOTP.

Super Admin cannot retrieve TOTP secrets.

---

#### 51. Security Events

Table:

- Time
- User
- Tenant if relevant
- Event
- IP/Device
- Risk
- Result
- Action

Events:

- Failed Login
- MFA Failure
- Password Reset
- Account Lock
- Role Escalation
- Scope Change
- Support Access
- Export Request
- Suspicious Activity

---

#### 52. Audit Logs

Super Admin gets platform-wide audit visibility.

Filters:

- Tenant
- User
- Module
- Event
- Date
- Result

Columns:

- Time
- Tenant
- User
- Role
- Module
- Action
- Resource
- Result
- Action

Audit logs are effectively immutable.

---

#### 53. Audit Events

Include:

- Tenant created
- Tenant approved
- Tenant suspended
- Business Owner created
- Plan changed
- Module changed
- Credits allocated
- Support session started
- Support action
- Provider changed
- Security change
- User access change
- Soft deletion
- Restore
- Purge
- Platform settings changed

---

#### 54. Soft Delete

All destructive tenant deletion begins as **soft delete**.

Conceptual fields:

deleted\_at

deleted\_by

deletion\_reason

purge\_after



Effects:

- login disabled
- tenant hidden from normal active lists
- integrations disabled
- scheduled jobs disabled
- data preserved until retention expiry

---

#### 55. Restore

Before purge date, authorized Super Admin can restore.

Action:

**Restore Dealership**

Requires reason.

All restore actions audited.

---

#### 56. Permanent Purge

No immediate hard delete from normal UI.

After retention period:

**scheduled purge job**

checks eligible tenants.

Use **Trigger.dev scheduled workflow**.

Process should:

1. verify purge eligibility
2. lock record
3. create final audit/purge manifest
4. remove private storage objects
5. remove dependent tenant data in controlled sequence
6. remove/revoke auth identities according to platform policy
7. mark purge completed

This should be retry-safe/idempotent.

---

#### 57. Data Retention Page

Table:

- Dealership
- Soft Deleted At
- Deleted By
- Reason
- Retention Period
- Purge After
- Legal/Hold Status
- Action

Actions:

- Restore
- Extend Retention
- Put on Hold
- Review Purge

---

#### 58. Platform Settings

Global settings only.

Examples:

- Default SLA templates
- Default plan settings
- Default module availability
- Credit conversion configuration
- Default support-session maximum
- Default retention period
- Platform email sender
- platform feature flags
- platform branding
- global limits

Do not put dealership-specific settings here.

---

#### 59. Default Tenant Templates

Super Admin can define defaults used when a dealership is created.

Examples:

- Default Lead Lifecycle
- Default Temperature Values
- Default Call Outcomes
- Default Follow-up Reasons
- Default Appointment Types
- Default Operational Workflows
- Default Roles
- Default Permission Sets

Client Admin can later customize allowed tenant-level settings.

---

#### 60. Reports

Super Admin reports are platform/business SaaS reports.

Examples:

- Dealership Growth
- Active Tenant Usage
- Users per Tenant
- Branches per Tenant
- Lead Volume by Tenant
- Booking Volume by Tenant
- Module Adoption
- AI Usage
- Tracking Usage
- Credit Consumption
- Integration Health
- Support Usage
- Error Rate
- Security Events
- Soft Deletion/Retention
- Plan/Entitlement Usage

---

#### 61. Report Charts

Use:

###### Apache ECharts Line

Growth / usage over time.

###### Apache ECharts Bar

Tenant/module/provider comparisons.

###### Apache ECharts Donut

Plan/module/status distribution.

Do not create charts where tables are clearer.

---

#### 62. Heavy Exports

Large reports/exports use:

**Trigger.dev**

Do not keep web request open for long-running exports.

Create:

```
report_job
```

→ background generate

→ private file

→ short-lived signed download

---

#### 63. Table Standard

All platform tables:

**shadcn Table + TanStack Table**

Server-side:

- filtering
- sorting
- pagination
- search

Default:

**25 rows**

Options:

**25 / 50 / 100**

---

#### 64. Page-Local Search

Dealerships page searches:

- Organization Name
- Tenant ID
- Owner Email
- Phone

Provider page:

- Provider
- Adapter

Audit:

- Tenant
- User
- Action
- Resource

No unnecessary global cross-platform text search.

---

#### 65. Debounced Search

Use approximately:

**300ms debounce**

Cancel obsolete requests.

Use indexed PostgreSQL queries.

---

#### 66. Database Indexing

Important indexes around:

- tenant\_id
- tenant\_status
- owner\_user\_id
- plan\_id
- created\_at
- deleted\_at
- provider
- support\_session\_status
- ledger tenant/type/date
- audit tenant/date/action

Use `pg_trgm + GIN` for fuzzy dealership-name search where useful.

---

#### 67. Virtualization

Use **TanStack Virtual** only for:

- very large audit views
- long credit ledgers
- high-density provider logs
- large tenant-selection lists

Do not virtualize ordinary paginated 25-row tables.

---

#### 68. TanStack Query

All server state.

Default:

staleTime = 60 seconds

gcTime = 30 minutes

refetchOnWindowFocus = false

refetchOnReconnect = true



Manual Refresh:

**max 3/minute/user/page-resource**

---

#### 69. Query Invalidation

Example:

Adding credits:

invalidate:

- Tenant Credit Balance
- Tenant Credit Ledger
- Credits Dashboard relevant totals

Do not reload the entire platform.

---

#### 70. Zustand

Only:

- sidebar
- modal/dialog
- filters
- selected tenant context
- support-session UI context
- temporary form state

Never use Zustand as server-state storage.

---

#### 71. IndexedDB

Use only for selected non-sensitive cached platform data.

Never persist client-side:

- provider secrets
- MFA secrets
- tenant secrets
- permanent auth tokens
- private exports
- support credentials

---

#### 72. Trigger.dev

Use for:

- tenant onboarding notifications
- provider retries
- AI jobs
- report exports
- purge jobs
- scheduled retention checks
- support-session expiration safety jobs
- integration retries
- large platform jobs
- credit notifications
- plan/limit notifications

---

#### 73. RLS / Tenant Isolation

Normal tenant application data remains isolated through Supabase RLS.

Super Admin platform functions should use explicit privileged backend pathways, not casually bypass tenant isolation from the browser.

For tenant support:

access must be bound to the accepted **support\_session\_id + tenant\_id + scope + expiry**.

---

#### 74. Super Admin Cannot

Even Super Admin should not be able to casually:

- see permanent passwords
- see MFA secrets
- reveal provider credentials
- silently impersonate users
- secretly enter tenant accounts
- hard-delete tenant data immediately
- modify tenant data outside an authorized support/admin workflow without audit

High authority should still be controlled.

---

#### 75. Super Admin vs Business Owner

###### Super Admin

Owns platform-level lifecycle:

- tenant creation
- onboarding approval
- plans/features
- credits
- platform providers
- platform security
- support access
- retention
- platform health

###### Business Owner

Owns executive dealership oversight:

- business performance
- company profile
- Client Admins
- credits visibility
- support approval

---

#### 76. Super Admin vs Client Admin

###### Super Admin

Controls platform availability.

###### Client Admin

Configures the dealership CRM internally.

Example:

Super Admin:

**Inventory Module = Enabled for Dealership A**

Client Admin then decides:

**Which dealership users can access Inventory?**

---

#### 77. Super Admin Permission Summary

| **Capability**                       | **Super Admin**   |
| ------------------------------------ | ----------------- |
| View platform dashboard              | ✅                 |
| Create dealership tenant             | ✅                 |
| Create initial Business Owner invite | ✅                 |
| See permanent owner password         | ❌                 |
| Approve onboarding                   | ✅                 |
| Request changes                      | ✅                 |
| Suspend tenant                       | ✅                 |
| Restore tenant                       | ✅                 |
| Soft delete tenant                   | ✅                 |
| Immediate hard delete                | ❌                 |
| Configure plan                       | ✅                 |
| Enable modules                       | ✅                 |
| Allocate AI credits                  | ✅                 |
| Allocate tracking credits            | ✅                 |
| View tenant usage                    | ✅                 |
| Configure platform providers         | ✅                 |
| Reveal provider secrets              | ❌                 |
| Request tenant support access        | ✅                 |
| Enter tenant without consent         | ❌                 |
| Support session max 1 hour           | ✅                 |
| Platform health                      | ✅                 |
| Platform audit                       | ✅                 |
| Platform security                    | ✅                 |
| Retention/purge management           | ✅                 |
| Create platform admin                | Highly restricted |
| Work normal sales leads              | ❌                 |

---

#### 78. Complete New Client Lifecycle

SUPER ADMIN

      ↓

CREATE DEALERSHIP ORGANIZATION

      ↓

CREATE INITIAL BUSINESS OWNER

      ↓

SEND SECURE INVITE

      ↓

OWNER FIRST LOGIN

      ↓

PASSWORD SETUP

      ↓

MANDATORY MFA

      ↓

COMPANY ONBOARDING

      ↓

DOCUMENTS

      ↓

SUBMIT

      ↓

UNDER REVIEW

      ↓

SUPER ADMIN REVIEW

   ↙            ↓              ↘

CHANGE       APPROVE          REJECT

REQUIRED        ↓

            ACTIVE

               ↓

BUSINESS OWNER

               ↓

CREATE CLIENT ADMIN

               ↓

CLIENT ADMIN CONFIGURES CRM




---

#### 79. Complete Support Lifecycle

TENANT NEEDS HELP

      ↓

SUPER ADMIN REQUESTS ACCESS

      ↓

OWNER / CLIENT ADMIN REVIEWS

      ↓

ACCEPT

      ↓

SUPPORT MAINTENANCE MODE

      ↓

NORMAL USERS BLOCKED

      ↓

SUPER ADMIN ENTERS

SCOPED SUPPORT CONTEXT

      ↓

FULL AUDIT

      ↓

MAXIMUM 1 HOUR

      ↓

END / AUTO EXPIRE

      ↓

TENANT ACTIVE




---

#### 80. Final Platform Architecture

GO DIGITAL MARKETING

        │

        ├── SUPER ADMIN

        │      │

        │      ├── Dealership Management

        │      ├── Onboarding Approval

        │      ├── Plans / Modules

        │      ├── Credits / Usage

        │      ├── Providers

        │      ├── Support

        │      ├── Security

        │      ├── Audit

        │      └── Platform Health

        │

        └── DEALERSHIP TENANT

               │

               ├── Business Owner

               ├── Client Admin

               ├── System Administrator

               ├── GM

               ├── Showroom Manager

               ├── Team Manager

               ├── Telecaller

               ├── Sales Consultant

               └── Operational Departments



This completes the main architecture.

**Telecaller → Sales Consultant → Team Manager → Showroom Manager → GM Sales → Client Admin → Operational Departments → System Administrator → Business Owner → Super Admin** are now all covered and can be treated as the frozen role/module foundation for the final CRM build blueprint.

Yes pa — this is possible, and we should freeze it like this.

**Client Admin:** by default, the main Client Admin should see **all customers across all branches of that dealership**. Customer 360 is organization-wide for them. If later the Business Owner creates an additional delegated Client Admin, we can optionally restrict that admin to selected branches, but the normal/default Client Admin is **ALL\_BRANCHES**.

For **branch-wise Google Business Profile, Google Ads, Meta/Facebook/Instagram, WhatsApp, IVR, etc.**, the connection should be done by **Client Admin or System Administrator with** **`integration.manage`** **permission**. Digital Marketing can manage campaigns/content/reporting, but should not normally see provider secrets.

Each connection gets its own scope:

**ONE\_BRANCH | SELECTED\_BRANCHES | ALL\_BRANCHES**

Example:

- Google Business Profile Location A → MG Road Branch
- Google Business Profile Location B → Whitefield Branch
- Meta Account A → MG Road + HSR
- Google Ads Account → All Branches
- WhatsApp Business Number A → Whitefield only
- IVR Provider B → Selected branches

So one dealership can use **separate accounts per branch** or **one shared account mapped to several/all branches**.

For messaging, yes — we can build a **CRM conversation inbox**, but only using official connected business APIs where supported:

**WhatsApp Business Platform/API + Facebook Messenger + Instagram Messaging**

Then the CRM can store the conversation against:

**Customer → Lead → Conversation Timeline**

Telecaller/Sales can see the history, reply from CRM, and managers can see it according to permission.

For WhatsApp, if you want **proper tracking**, use the dealership's official **WhatsApp Business Platform/API**. Do not depend on normal/personal WhatsApp for synchronization because the CRM cannot reliably capture that history.

So final communication rule:

**Telecaller / Sales Consultant**
→ use CRM-connected WhatsApp Business / Messenger / Instagram when tracking is required.

**Operational users**
→ they don't need a heavy inbox by default. They can use the connected business channel if enabled, or communicate externally and press **Mark as Sent / Mark as Contacted**.

Example:

> WhatsApp — Manually Sent
> By: RTO Executive
> 13 Aug 2026, 4:30 PM

That keeps operations simple while Sales gets the full tracked conversation history.

And **Super Admin does not normally connect a dealership's Meta/Google/WhatsApp account**. Super Admin manages the platform adapter/provider. If the client needs help, Super Admin can configure it during the **approved 1-hour Support Session** we designed.


---

## 55. Final page-build rule

Before creating any route, the implementing agent must search this file for the page name and role. If a reusable domain component/preset already exists, extend that preset instead of copying the page. For every list/dashboard/detail page, apply Section 52 automatically even when the embedded role PRD does not repeat pagination/debounce/loading/security mechanics word-for-word.

A route is not accepted when it merely renders a sidebar and placeholder cards. It is accepted only when the correct role scope, KPIs, analytics, filters, table/list fields, row actions, drill-down, backend query/RPC, mutation rules, audit behavior, loading/error/empty states and responsive behavior are all implemented.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
