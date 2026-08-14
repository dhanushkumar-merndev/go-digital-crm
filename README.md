# Go Digital Marketing CRM

Production-oriented foundation for the multi-tenant automobile dealership CRM defined in [AGENTS.md](./AGENTS.md).

## Included architecture

- Next.js 16, strict TypeScript, Tailwind CSS and shadcn-style primitives
- TanStack Query server-state defaults and TanStack Table server-pagination contracts
- Apache ECharts dashboards (line, bar, donut and funnel)
- Zustand for shared responsive UI state
- Supabase Auth, TOTP MFA, tenant-status gating, PostgreSQL/RLS/RPC migrations and Edge Functions
- Tigris private S3-compatible object adapter and direct presigned transfers
- Brevo transactional email boundary
- Trigger.dev v4 long-running recording ingestion and scheduled retention work
- Expo Router mobile MVP for Telecaller and Sales Consultant, SecureStore sessions, AsyncStorage state and SQLite test-drive route buffering

The web app has an environment-safe preview mode when Supabase variables are absent. Preview data is intentionally isolated in `src/lib/demo-page-repository.ts`; production authorization and domain persistence live at the Supabase boundary.

## Local web development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Without Supabase variables, the home route opens the Telecaller preset and the role switcher exposes the approved role workspaces for visual/manual QA.

## Configuration

Copy `.env.example` to `.env.local` and supply the configured project values. Never expose `SUPABASE_SERVICE_ROLE_KEY`, Tigris credentials, Brevo credentials, Trigger credentials, encryption keys or provider secrets through `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` variables.

Apply the migrations in order and seed catalogs:

```bash
supabase db reset
supabase functions serve
```

Deploy each focused function from `supabase/functions/` according to the target Supabase project. Configure provider/Tigris/Brevo secrets through Supabase Edge secrets, not database rows readable by clients.

For Trigger.dev, set `TRIGGER_PROJECT_REF` and `TRIGGER_SECRET_KEY`, then deploy the tasks in `trigger/` using the current Trigger.dev v4 CLI.

## Mobile

```bash
pnpm --dir mobile start
```

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` for the Expo environment. Provider/service credentials never belong in Expo variables. Test-drive background location requires a development or production build; Expo Go cannot validate every background-location behavior.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:api
pnpm build
pnpm --dir mobile typecheck
```

Automated tests intentionally cover backend/API/domain contracts only. UI validation remains manual per the product contract.

## Important invariants

- Customer UUID is the source of truth; phone/email are match/search identifiers only.
- Possible customer matches require an explicit authorized link decision.
- `Pending` is derived work state and never a lead lifecycle value.
- Role and data scope remain independent; scope ceilings are enforced server-side.
- There is no Team Leader role.
- Ordinary product actions soft-delete business data.
- Large/private objects use Tigris object keys plus short-lived server-authorized URLs.
