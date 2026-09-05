# Go Digital Marketing CRM

## Product, Pages, Roles, Permissions & Providers — Simple Guide

Prepared: 23 August 2026  
Document type: Stakeholder product brief  
Source: Current repository navigation, page specifications, security migrations, provider adapters and background jobs

This document explains what the Go Digital Marketing CRM does, which pages each role uses, what those pages are for, how access is controlled, and which external providers support the product.

> Important: This is a concise functional guide to the current configured product scope. Some screens use shared or preview page frameworks while live Supabase queries and workflows are completed. The database, Row Level Security, permissions and server-side workflows remain the final authority for real access.

## 1. Product at a glance

Go Digital Marketing CRM is a multi-tenant automobile dealership CRM. It helps a dealership collect leads, communicate with customers, manage sales work, create quotations and bookings, coordinate operational departments, and monitor performance.

The organization hierarchy is:

- **Platform:** Go Digital Marketing controls the overall SaaS platform.
- **Dealership organization / tenant:** One dealership company and its isolated data.
- **Branches:** Physical showrooms or dealership locations.
- **Teams:** Sales or operational teams inside a branch.
- **Users:** People who receive a role, permissions and a separate data scope.

The security rule is:

- **User > Role > Permissions > Data Scope**
- A role says what a user may do.
- Data scope says which records, teams or branches the user may access.
- A role name never automatically means a particular branch scope.

## 2. Main business journey

### Lead to customer and sale

1. A lead arrives from Meta, Google Ads, WhatsApp, website, partner portal or manual entry.
2. The CRM checks for possible customer matches using phone/email as search identifiers.
3. It never silently merges customers. An authorized user chooses to link the lead or create a new customer.
4. The lead is assigned by Round Robin (default) or Manual Assignment, based on team settings.
5. Telecaller or Sales Consultant contacts the customer and records calls, messages, tasks and follow-ups.
6. The opportunity can progress through appointment, test drive, quotation and booking.
7. Booking-linked work moves to inventory, exchange, finance, insurance, RTO and delivery teams.
8. Customer Care records feedback, complaints and escalations after the sale.

### Customer and lead rules

- **Customer is the long-term source of truth.** A customer can have many leads, bookings, purchases and vehicles.
- `customer_id` is an immutable UUID. Phone and email are only matching/search fields.
- **Lead is one enquiry or opportunity.** The same customer can return with another lead later.
- Important assignment and reassignment actions are audited.

### Lead lifecycle and work-state

Lifecycle states are:

- New
- Contacted
- Qualified
- Appointment Scheduled
- Transferred to Sales
- Lost

Sales events can additionally include Test Drive, Quotation and Booking.

Work-state is calculated separately:

- **New Today:** Uncontacted for less than 24 hours.
- **Pending:** Uncontacted for 24 hours or more.
- **SLA Risk:** Past the configured response SLA.

`Pending` is not a lifecycle stage and must not be stored as an automatic stage change.

## 3. Role hierarchy

### Platform authority

- **Super Admin:** Platform-level authority across dealership tenants.

### Dealership executive and administration

- **Business Owner:** Organization-wide executive visibility and control over company, Client Admin, credits, compliance and support approval.
- **Client Admin:** Primary dealership CRM and business configuration authority.
- **System Administrator:** Delegated technical administration within assigned scope.

### Final sales hierarchy

- **GM Sales Executive**
- **Showroom Manager**
- **Team Manager**
- **Sales Consultant + Telecaller / BDC Executive**

There is **no Team Leader role**. A Sales Consultant may receive an optional Telecaller capability bundle without creating a second user.

### Operational roles

- Inventory Manager / Inventory Team
- Finance Manager / Finance Executives
- Insurance Manager / Insurance Executives
- RTO Manager / RTO Executive
- Used Car / Exchange Manager / Team
- Delivery Manager / Delivery Executives
- Customer Relationship Manager / CRM and Feedback Executives
- Digital Marketing Manager / Campaign and Social Executives

Operational role names do not encode branch scope.

## 4. Permissions and data scope

### Supported data scopes

- **OWN_RECORDS:** Records owned by or assigned to the user.
- **OWN_TEAM:** Records available to the user's team.
- **ONE_BRANCH:** Exactly one selected branch.
- **SELECTED_BRANCHES:** One or more named branches.
- **ALL_BRANCHES:** Every branch in the dealership; no branch list is stored with this mode.
- **ORGANIZATION:** Organization-wide executive or administrative access.
- **PLATFORM:** Cross-tenant platform access for authorized platform roles.

### Permission families

Permissions are action-based and checked separately from data scope. Important families include:

- Customers: view, create and explicitly link a reviewed match.
- Leads: view, create, update, assign and reassign.
- Calls and messaging: view, create/update call outcomes, view conversations and send approved messages.
- Work: view/create/update/complete/cancel tasks, follow-ups and appointments; managers may assign or override within scope.
- Test drives: view or manage scheduling and progress.
- Quotations and bookings: view or manage.
- Operations: finance, insurance, RTO, exchange, delivery and customer-care view/manage actions.
- Inventory: stock check, VIN-level view, create, update, move and allocate.
- Administration: users, roles, branches and teams.
- Integrations: view health or manage provider connections and mappings.
- Marketing: view/manage campaigns, social drafts and automation.
- Documents and reports: private upload/download, report view and controlled export.
- Governance: approvals, audit, credits and support-session actions.

### Safety rules

- Database Row Level Security enforces organization, permission, branch, team and record scope.
- Hiding a button in the web interface is not treated as security.
- A manager cannot grant a role, permission or scope above their own delegation ceiling.
- Important mutations are audited.
- Ordinary product actions soft-delete business data; controlled background purge follows policy.
- Privileged provider secrets are server-side only and are never revealed in the browser or mobile app.

## 5. Role authority summary

### Super Admin

- **Typical scope:** PLATFORM.
- **Main authority:** Dealership onboarding, platform users, plans, modules, entitlements, platform credits, provider health, support sessions, security, audit, retention and platform settings.
- **MFA:** TOTP required.
- **Limit:** Tenant business access is through an approved, time-limited and audited support session.

### Business Owner

- **Typical scope:** ORGANIZATION.
- **Main authority:** Executive dashboards, company/compliance, Client Admin management, credit visibility, support approval, security and reports.
- **MFA:** TOTP required.
- **Style:** Read-heavy executive access; does not perform ordinary frontline lead work.

### Client Admin

- **Typical scope:** ORGANIZATION by default; delegated Client Admins may be branch-scoped.
- **Main authority:** Branches, teams, users, roles, permissions, CRM settings, modules, targets, provider connections, audit and reporting.
- **MFA:** TOTP required.
- **Customer access:** Primary Client Admin can see customers across the organization.

### System Administrator

- **Typical scope:** ONE_BRANCH, SELECTED_BRANCHES or another delegated scope.
- **Main authority:** Users, delegated roles, branch access, master data, integrations, automations, templates, alerts, health, backup/data controls and security.
- **MFA:** TOTP required.
- **Limit:** Cannot exceed delegated authority; platform credit allocation and Business Owner support approval are not ordinary default powers.

### GM Sales Executive

- **Typical scope:** ALL_BRANCHES.
- **Main authority:** Cross-showroom sales visibility, performance comparisons, rankings, targets, approvals, lost leads, escalations and reports.
- **MFA:** TOTP required.
- **Style:** Read-heavy management role with controlled approval and escalation actions.

### Showroom Manager

- **Typical scope:** ONE_BRANCH or authorized branches.
- **Main authority:** Showroom leads, assignment, sales work, quotations, bookings, approvals, teams, targets, escalations and reports.
- **MFA:** Configurable unless sensitive/all-branch policy requires it.
- **Delegation:** User-management page appears only with `users.manage.delegated` capability.

### Team Manager

- **Typical scope:** OWN_TEAM.
- **Main authority:** Team lead queue, assignment, follow-ups, calls, appointments, test drives, quotations, bookings, performance, lost leads and escalations.
- **MFA:** Optional/configurable by policy.

### Sales Consultant

- **Typical scope:** OWN_RECORDS.
- **Main authority:** Own leads, customer communication, tasks, appointments, test drives, quotations, stock check, exchange requests and bookings.
- **MFA:** Optional/configurable by policy.
- **Extra:** Can receive the Telecaller capability bundle without a second account.

### Telecaller / BDC Executive

- **Typical scope:** OWN_RECORDS.
- **Main authority:** New and assigned leads, calls, inbox, follow-ups, tasks, appointments, timeline and personal performance.
- **MFA:** Optional/configurable by policy.
- **Limit:** No Team Leader role and no general team-management authority.

### Inventory Manager

- **Typical scope:** ONE_BRANCH or authorized branches.
- **Main authority:** VIN-level vehicle inventory, allocation, ageing and stock transfer.
- **Key permissions:** Inventory view/create/update/move/allocate plus scoped documents and reports.

### Finance Manager

- **Typical scope:** Branch or selected branches.
- **Main authority:** Finance cases, document collection, applications and disbursement progress.

### Insurance Manager

- **Typical scope:** Branch or selected branches.
- **Main authority:** Insurance case creation, document tracking and progress.

### RTO Manager

- **Typical scope:** Branch or selected branches.
- **Main authority:** RTO registration cases, documents, status and completion.

### Used Car / Exchange Manager

- **Typical scope:** Branch or selected branches.
- **Main authority:** Exchange requests, evaluations and accepted exchange cases.

### Delivery Manager

- **Typical scope:** Branch or selected branches.
- **Main authority:** Delivery planning, checklist control, readiness, proof photos, completion and feedback.

### Customer Relationship Manager

- **Typical scope:** ONE_BRANCH or SELECTED_BRANCHES.
- **Main authority:** Customer-care cases, follow-ups, feedback, reviews, complaints and escalation.

### Digital Marketing Manager

- **Typical scope:** ORGANIZATION or an explicitly assigned branch scope.
- **Main authority:** Lead sources, campaigns, drip automation, social drafts, review requests, AI content/image creation and marketing performance.
- **Integration authority:** Limited connection/mapping workflows only when explicitly permitted.

## 6. Common page functions

- **Dashboard:** Shows KPI cards, urgent work, pipeline movement, charts and recent records for the signed-in role and scope.
- **Lead pages:** Search, filter and work customer opportunities without loading the full tenant dataset.
- **Assignment pages:** Route leads through Round Robin or Manual Assignment and keep reassignment history.
- **Follow-ups and Tasks:** Track promised actions, due dates, overdue work, ownership and completion outcomes.
- **Calls and Inbox:** Record call outcomes, provider call references, recordings, transcripts and approved WhatsApp/provider messages.
- **Appointments and Test Drives:** Schedule visits and drives, update outcomes and review route/feedback summaries.
- **Quotations and Bookings:** Create versioned quotations, request approvals and carry confirmed business into operational delivery.
- **Performance pages:** Compare activity, conversions and targets at personal, team, branch or organization scope.
- **Reports:** View scoped aggregate reporting and request auditable private exports in the background.
- **Administration pages:** Configure organizational structure, users, roles, scopes, modules, provider connections and policy.
- **Operational case pages:** Use booking-linked workflows for finance, insurance, RTO, exchange and delivery.

## 7. Page catalog by role

The following catalog lists every configured navigation page and its simple purpose.

### Telecaller / BDC Executive — Own records

- **Dashboard:** Daily lead, call, follow-up and SLA priorities.
- **New Leads:** Fresh, uncontacted opportunities that need first action.
- **My Leads:** All leads assigned to the signed-in Telecaller.
- **Follow-ups:** Due, overdue and upcoming customer commitments.
- **Tasks:** Lead-linked personal work and completion outcomes.
- **Activity Timeline:** Chronological calls, messages, follow-ups, tasks and permitted sales events.
- **Calls:** Make or log calls, record outcomes and view available recordings.
- **Inbox:** View provider conversations and send allowed WhatsApp replies/templates.
- **Appointments:** Schedule and update customer visits within own scope.
- **Performance:** Personal contact, qualification and productivity results.

### Sales Consultant — Own records

- **Dashboard:** Personal pipeline, next actions, booking progress and SLA risks.
- **My Leads:** Assigned sales opportunities and lifecycle actions.
- **Follow-ups:** Due and scheduled customer follow-up work.
- **Tasks:** Lead-linked work, priority, status and outcome.
- **Calls:** Call activity, outcomes, recording and transcript availability.
- **AI Voice Calls:** Start or review AI-assisted calling workflows when enabled and credited.
- **Inbox:** Provider conversation history and permitted replies.
- **Appointments:** Customer showroom and sales appointments.
- **Test Drives:** Schedule drives, anchor vehicles, run sessions and review outcomes.
- **Competitor Compare:** Compare configured competitor models and talking points.
- **Quotations:** Create and manage versioned customer quotations.
- **Stock Check:** View aggregate availability without exposing unauthorized VIN details.
- **Exchange:** Originate and follow a booking-linked exchange request.
- **Bookings:** Create and track confirmed bookings within own scope.
- **Performance:** Personal targets, conversion and activity results.

### Team Manager — Own team

- **Dashboard:** Team pipeline, workload, SLA and urgent actions.
- **Team Leads:** Search and progress team-owned opportunities.
- **Lead Assignment:** Assign or reassign leads to eligible team members.
- **Follow-ups:** Monitor team due and overdue follow-ups.
- **Team Calls:** Review call volume, connection, outcomes and recording status.
- **Appointments:** Coordinate team customer appointments.
- **Test Drives:** Monitor and manage team test drives.
- **Quotations:** Review and manage team quotations.
- **Bookings:** Track team bookings and pending handoffs.
- **Team Performance:** Compare team member targets and conversions.
- **Lost Leads:** Review lost opportunities and reason quality.
- **Escalations:** Resolve scoped sales exceptions with an audit trail.
- **Reports:** View and export approved team-level aggregate reports.

### Showroom Manager — Branch scope

- **Dashboard:** Showroom KPIs, pipeline, teams and urgent risks.
- **Showroom Leads:** All authorized branch opportunities.
- **Lead Assignment:** Balance branch leads across eligible teams and users.
- **Follow-ups:** Monitor branch customer commitments.
- **Team Calls:** Review branch/team call performance and outcomes.
- **Appointments:** Coordinate showroom appointments.
- **Test Drives:** Manage scheduled, active and completed branch drives.
- **Quotations:** Review and manage branch quotations.
- **Bookings:** Track showroom bookings, allocation and delivery handoff.
- **Approvals:** Decide requests within the manager's authority limit.
- **Sales Teams:** Review teams, membership, workload and assignment mode.
- **Showroom Targets:** Set or monitor authorized branch targets.
- **Performance:** Compare branch teams and conversion results.
- **Lost Leads:** Review branch losses and coaching patterns.
- **Escalations:** Resolve branch sales exceptions.
- **Reports:** Scoped branch reporting and private exports.
- **Users:** Manage delegated users only when the additional capability is granted.

### GM Sales Executive — All branches

- **Dashboard:** Organization-wide sales KPIs and priority exceptions.
- **Sales Leads:** Cross-branch lead visibility within permission policy.
- **Showroom Comparison:** Compare branches by activity, conversion and targets.
- **Sales Performance:** Review the overall sales funnel and results.
- **Sales Consultant Ranking:** Rank consultants using scoped performance measures.
- **Lead Source Performance:** Compare source quality, qualification and bookings.
- **Model Performance:** Compare interest, test drives, quotations and bookings by vehicle model.
- **Targets:** Review or manage controlled sales targets.
- **Approvals:** Decide sales approvals within authority limits.
- **Bookings Overview:** Read cross-branch booking value and status.
- **Lost Leads:** Analyze loss reasons across branches.
- **Escalations:** Review and resolve authorized sales escalations.
- **Reports:** Cross-branch aggregate reports and approved exports.
- **Users:** Manage delegated users only when the additional capability is granted.

### Client Admin — Organization

- **Dashboard:** Tenant health, sales/operations summary and administrative alerts.
- **Branches:** Create and configure dealership branches.
- **Teams:** Create teams, manage membership and assignment mode.
- **Users:** Invite, update, suspend and scope users within authority ceiling.
- **Roles & Permissions:** Maintain role capabilities separately from data scope.
- **Lead & Assignment Settings:** Configure SLA, routing and Round Robin/Manual Assignment rules.
- **CRM Configuration:** Manage dealership CRM business settings.
- **Competitor Catalog:** Maintain competitor models used in sales comparison.
- **Custom Fields:** Define approved tenant fields without changing core entity identity.
- **Integrations:** Connect providers, map assets to branches and monitor health.
- **Modules & Access:** Enable entitled modules and assign access.
- **Targets & Approval Rules:** Configure targets, limits and approval routing.
- **AI & Usage:** Configure permitted AI capabilities and view consumption.
- **Company & Compliance:** Maintain legal, GST, dealership and required document information.
- **Audit Logs:** Review privileged and business-critical events.
- **Reports:** Organization-level reporting and controlled export.

### System Administrator — Selected branches

- **Dashboard:** Technical health, access alerts and delegated operational status.
- **Users:** Manage users within role and scope ceiling.
- **Roles & Permissions:** Manage delegated roles and allowed permissions.
- **Branches & Access:** Configure branch access assignments within authority.
- **Master Data:** Maintain authorized catalogs and reference data.
- **Integrations:** Configure and troubleshoot permitted provider connections.
- **Automation Rules:** Create auditable provider-independent workflow rules.
- **Templates:** Maintain approved message, email and workflow templates.
- **Alerts & Notifications:** Configure operational and security alerts.
- **System Health:** Review service, job and provider health without secrets.
- **Audit Logs:** Review scoped administration and security events.
- **Backup & Data Management:** Control approved backup, export and retention operations.
- **Security:** Review MFA, access policy and security configuration.
- **Reports:** Scoped reports and approved exports.

### Business Owner — Organization

- **Dashboard:** Executive KPIs, risks and business attention items.
- **Sales Overview:** Organization sales funnel, conversion and revenue indicators.
- **Showroom Performance:** Compare branch performance and target attainment.
- **Operations Overview:** Review finance, insurance, RTO, exchange and delivery health.
- **Bookings & Delivery:** Track confirmed business through expected delivery.
- **Targets & Performance:** Review organization targets and outcomes.
- **AI Business Summary:** Read an AI-assisted summary when the feature is enabled.
- **Reports:** Executive aggregate reports and controlled exports.
- **Client Admins:** Create or manage authorized Client Admin accounts.
- **Company & Compliance:** Maintain organization/legal information and review status.
- **Credits & Usage:** View append-only AI and tracking credit balances and usage.
- **Support & Maintenance:** Request, approve or end time-limited support access.
- **Security & Access:** Review privileged access, MFA and security state.

### Super Admin — Platform

- **Dashboard:** Cross-tenant platform KPIs, incidents and urgent actions.
- **Dealerships:** Create and manage dealership tenant records and status.
- **Onboarding Reviews:** Approve, request changes or reject Business Owner onboarding.
- **Business Owners:** Manage initial and authorized dealership owners.
- **Plans & Features:** Configure subscription plans and feature availability.
- **Modules & Entitlements:** Grant tenant module entitlements.
- **Credits & Usage:** Allocate platform credits and review tenant consumption.
- **Integrations & Providers:** Monitor adapters and provider health across the platform.
- **Support Sessions:** Request/control audited tenant support access.
- **Platform Health:** Monitor services, queues, jobs and sanitized failures.
- **Users & Access:** Manage platform identities and privileged access.
- **Security:** Review platform MFA and security controls.
- **Audit Logs:** Review platform-level security and business-critical actions.
- **Data Retention & Deletion:** Control legal holds, deletion requests and scheduled purge.
- **Platform Settings:** Maintain platform-wide safe configuration.
- **Reports:** Platform reporting and controlled private exports.

### Inventory Manager — Branch scope

- **Dashboard:** Stock availability, ageing, allocation and movement alerts.
- **Vehicle Inventory:** VIN/chassis-level vehicle stock and lifecycle status.
- **Stock Allocation:** Allocate or release stock against bookings.
- **Stock Ageing:** Identify slow-moving units by age and model.
- **Stock Transfer:** Move stock between mutually authorized branches.
- **Reports:** Inventory aggregate reports and controlled exports.
- **My Performance:** Personal/department throughput and target measures.

### Finance Manager — Branch scope

- **Dashboard:** Finance pipeline, missing documents, due work and disbursement status.
- **Finance Cases:** Create and progress booking-linked finance cases.
- **Pending Documents:** Track missing or rejected finance documents.
- **Applications:** Monitor lender application status and actions.
- **Disbursement:** Track approved and completed disbursements.
- **Reports:** Finance aggregate reports and private exports.
- **My Performance:** Case completion and turnaround measures.

### Insurance Manager — Branch scope

- **Dashboard:** Insurance pipeline, documents and urgent renewals/actions.
- **Insurance Cases:** Create and progress booking-linked insurance cases.
- **Reports:** Insurance aggregate reports and controlled exports.
- **My Performance:** Case conversion and turnaround measures.

### RTO Manager — Branch scope

- **Dashboard:** RTO pipeline, missing documents and delayed registrations.
- **RTO Cases:** Progress booking/vehicle-linked registration work.
- **Reports:** RTO aggregate reports and controlled exports.
- **My Performance:** Registration throughput and turnaround measures.

### Used Car / Exchange Manager — Branch scope

- **Dashboard:** Exchange pipeline, pending inspections and accepted value.
- **Exchange Requests:** Review sales-originated booking-linked requests.
- **Evaluations:** Record inspection and valuation decisions.
- **Accepted Exchanges:** Track approved exchange vehicles and handoff.
- **Reports:** Exchange aggregate reports and controlled exports.
- **My Performance:** Evaluation and completion measures.

### Delivery Manager — Branch scope

- **Dashboard:** Upcoming deliveries, checklist risk and readiness.
- **Upcoming Deliveries:** View scheduled customer deliveries.
- **Delivery Planner:** Plan date, slot, vehicle and owner.
- **Pending Checklist:** Complete pre-delivery requirements.
- **Ready for Delivery:** Review cases cleared for customer handover.
- **Delivered:** Record completed deliveries and proof.
- **Delivery Photos:** Store authorized handover photos privately.
- **Feedback:** Capture post-delivery customer responses.
- **Reports:** Delivery aggregate reports and controlled exports.
- **My Performance:** On-time delivery and checklist measures.

### Customer Relationship Manager — Selected branches

- **Dashboard:** Customer-care workload, feedback and escalation priorities.
- **Customer Cases:** Create, assign and progress post-sale customer cases.
- **Follow-ups:** Schedule and complete customer-care actions.
- **Feedback:** Track response and satisfaction records.
- **Reviews:** Track approved review-request outcomes.
- **Complaints & Escalations:** Record complaints and escalate within authority.
- **Reports:** Customer-care aggregate reporting and export.
- **My Performance:** Resolution time, follow-up and satisfaction measures.

### Digital Marketing Manager — Organization

- **Dashboard:** Lead source, campaign and marketing attention summary.
- **Lead Sources:** Compare canonical source volume and quality.
- **Campaigns:** Create and maintain provider-independent campaign records.
- **Drip Campaigns:** Draft, schedule, pause and audit multi-step outreach.
- **Social Posts:** Create and schedule provider-safe social post drafts.
- **Reviews:** Create and monitor Google review-request workflows.
- **AI Content / Image:** Generate approved content/image assets using connected AI providers and credits.
- **Performance:** Compare campaign leads, qualification, bookings and available spend data.
- **Reports:** Marketing aggregate reports and controlled exports.

## 8. Customer 360

Customer 360 is opened from a customer or related record; it is not a normal sidebar page. Sections are shown only when the user has permission:

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

Operational records are linked through customer ID, booking ID, department case ID and vehicle/VIN where applicable.

## 9. Providers and external services

### Core platform services

- **Supabase:** PostgreSQL database, Auth, TOTP MFA, Row Level Security, realtime updates, transactional RPCs and focused Edge Functions.
- **Tigris Data:** Private S3-compatible object storage for call recordings, documents, photos, signatures, generated reports and AI files. Access uses short-lived server-authorized URLs.
- **Brevo:** Transactional email, invites, reports-ready messages, notices and Supabase Auth custom SMTP where supported.
- **Trigger.dev:** Long-running and scheduled jobs, retries, report export, provider event dispatch, recording ingestion, AI processing, retention purge and support-session expiry.
- **Upstash Redis (optional):** Server/Edge cache when explicitly configured; it is disabled by default.

### Lead, communication and business providers

- **Meta / Facebook / Instagram:** OAuth, asset discovery, Lead Ads ingestion and mapped Meta pages. Messaging/social functions depend on approved current provider permissions.
- **Google Ads:** OAuth, customer/campaign/lead-form discovery, branch mapping and lead-form ingestion.
- **Google Business Profile:** OAuth connection testing and business-location integration path; actual connected locations map to CRM branches.
- **WhatsApp Business Platform / Cloud API:** Inbound/outbound tracked conversations, delivery status and template/window-aware sending. Personal WhatsApp is not synchronized.
- **TeleCMI Voice / IVR:** Server-side connection, outbound call start, authenticated webhook processing, HTTP IVR/team/parallel-agent routing, call metadata and recording ingestion.
- **Generic provider webhook boundary:** Accepts validated provider events through tenant-isolated, idempotent workflows.

### AI providers

- **Groq:** Platform or tenant-configurable call transcription and analysis path.
- **OpenAI:** Configurable AI image generation provider.
- **Gemini:** Supported as a configurable tenant AI provider connection.
- AI credentials remain encrypted and server-only. Usage may require append-only platform credits.

### Maps and routes

- The product uses a maps adapter boundary and MapLibre GL for map display.
- Mobile test-drive route points are buffered locally in SQLite, then reduced/persisted through authorized workflows.
- A specific geocoding/routing provider must be configured behind the adapter; maps are not treated as charts.

## 10. Integration and provider safety

- Provider connections belong to a tenant and use ONE_BRANCH, SELECTED_BRANCHES or ALL_BRANCHES scope.
- External pages, campaigns, lead forms, locations and WhatsApp numbers are mapped to CRM branches.
- OAuth tokens and credentials are encrypted server-side; the interface shows status or masked values only.
- Users can replace credentials but cannot reveal existing plaintext secrets.
- Webhooks validate signatures/tokens, tenant connection, payload and idempotency.
- Provider API versions and scopes stay configurable in adapters and must be verified against current official documentation before release.
- Large work returns quickly from an Edge Function and continues in Trigger.dev.
- Provider recording URLs are temporary inputs; final recordings are copied into private Tigris storage.

## 11. Background jobs

- **Provider event dispatch:** Normalizes Meta, Google and WhatsApp events and handles mapped/unmapped records.
- **Provider outbox:** Retries Brevo email and WhatsApp deliveries and reconciles message status.
- **Provider recording ingest:** Safely downloads bounded provider audio and streams it to Tigris.
- **AI call processing:** Transcribes and analyzes eligible call recordings with credit controls.
- **AI image generation:** Creates private marketing assets through a connected AI provider.
- **Report export:** Builds approved aggregate exports and stores them privately.
- **Retention purge:** Executes controlled deletion policy and respects legal holds.
- **Support-session expiry:** Runs every minute and calls the database expiry function so support access ends automatically.

## 12. Authentication, onboarding and mobile

### Authentication

- Primary login is email + password.
- No phone-number login in MVP.
- Privileged roles must pass TOTP MFA before CRM access.
- Access also checks user status, tenant status, onboarding approval, role assignment, MFA level, maintenance mode and suspension/lock state.

### Business Owner onboarding

1. Super Admin creates the tenant and initial Business Owner.
2. Owner receives a secure invite/one-time setup path.
3. Owner changes the password and enrolls TOTP.
4. Owner enters company, legal, GST and dealer information and uploads required documents.
5. Submission moves to UNDER_REVIEW.
6. Super Admin approves, requests changes or rejects.
7. Normal CRM modules open only when the tenant becomes ACTIVE.

### Mobile MVP

- Mobile is React Native + Expo + Expo Router.
- Primary mobile workflows are for Telecaller and Sales Consultant.
- Web profile can generate a short-lived, one-time QR challenge to link the mobile app.
- The QR is not a password or permanent session token and becomes invalid after use/expiry.
- Sessions use secure storage; selected non-sensitive state uses AsyncStorage.
- Active test-drive route buffering uses local SQLite.

## 13. Technology and UI summary

- **Web:** Next.js, strict TypeScript, Tailwind CSS and shadcn/ui components.
- **Server state:** TanStack Query.
- **Tables:** TanStack Table with shadcn Table and server-side filtering, sorting, search and pagination.
- **Charts:** Apache ECharts only—line, bar, donut and funnel.
- **Local UI state:** Zustand.
- **Web non-sensitive persisted cache:** IndexedDB.
- **Mobile:** React Native, Expo and Expo Router.
- **Database/backend:** Supabase PostgreSQL/Auth/RLS/Edge Functions/Realtime.

The standard page design is a desktop left sidebar, compact header, KPI cards, attention list, useful charts and a dense but readable main table.

## 14. Data, performance and audit principles

- No page downloads a full tenant dataset into the browser.
- Large tables use server-side search, filtering, sorting and pagination.
- Default page size is 25, with 25/50/100 options.
- Search is resource-specific and approximately 300 ms debounced.
- Dashboard KPI data is bundled into a small number of aggregate queries.
- High-volume audit/provider logs use cursor pagination.
- Realtime invalidates only relevant cached queries.
- Important assignment, approval, role, provider and support actions are audited.
- Large/private documents never use a permanent public URL.

## 15. Simple glossary

- **Tenant:** One dealership organization with isolated data.
- **Branch:** A showroom or dealership location.
- **Team:** A group of users inside a branch/organization.
- **Role:** A named job authority such as Team Manager.
- **Permission:** One allowed action such as `lead.assign`.
- **Data scope:** The records/teams/branches where that permission may be used.
- **RLS:** Database rules that enforce tenant and scope isolation.
- **Lead:** One enquiry/opportunity.
- **Customer:** Long-term person/entity record across many enquiries and purchases.
- **Lifecycle:** Business stage of a lead.
- **Work-state:** Calculated urgency such as New Today, Pending or SLA Risk.
- **Provider connection:** A tenant-isolated link to Meta, Google, WhatsApp, TeleCMI, AI or another service.
- **Support session:** Explicit, approved, time-limited and audited platform access to a tenant.

## 16. Final product rules to remember

- Customer is the long-term source of truth.
- Never silently merge customers from a phone match.
- Role and data scope are always separate.
- There is no Team Leader role.
- Pending is a derived work-state, not a lead lifecycle stage.
- Round Robin is the default assignment mode; Manual Assignment is configurable.
- Privileged roles use TOTP MFA.
- Provider credentials stay server-side.
- Business data is soft-deleted first and purged only through controlled policy.
- Every provider integration is tenant-isolated and branch-scope aware.
