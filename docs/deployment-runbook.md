# Production deployment runbook

This runbook defines the release order and the minimum evidence required before a Go Digital Marketing CRM production release. It does not make the current feature set production-complete by itself.

## Release gates

Do not release until all of these are true:

- the GitHub `API and build checks` workflow is green, including the fresh Supabase migration chain
- `pnpm verify` passes with the pinned Node, pnpm and Deno toolchain
- `pnpm audit --prod` has no unaccepted high-severity findings; exceptions have an owner, expiry and compensating control
- a staging Supabase project has successfully applied the entire migration chain and seed
- API/backend integration tests pass against staging with at least two tenants and denial fixtures
- all required runtime environment groups pass the validator without printing values
- provider applications, OAuth redirect URLs, webhook URLs, permissions and production review are complete
- Brevo custom SMTP and approved application templates are configured
- Tigris bucket policy is private and upload/download authorization is smoke-tested
- Trigger.dev schedules and retries are observed in staging
- approved screenshots and acceptance flows have been manually checked on desktop and release mobile builds
- rollback owners, backup/restore access and incident contacts are recorded

The current repository still needs a verified remote deployment, complete live module coverage and the remaining API/RLS behavior tests before these gates can be signed off.

## Pinned toolchain

| Tool                | Repository pin               | Purpose                               |
| ------------------- | ---------------------------- | ------------------------------------- |
| Node.js             | `24.18.0` / `24.x` on Vercel | Next.js, Trigger.dev and Expo tooling |
| pnpm                | `11.21.0`                    | workspace install and scripts         |
| Deno                | `2.9.5`                      | Supabase Edge Function type-checking  |
| Supabase CLI        | `2.114.0` in scripts/CI      | migrations and Edge deployments       |
| Trigger.dev CLI/SDK | `4.5.11`                     | background task builds and deployment |
| EAS CLI             | `22.0.0`                     | mobile preview/production builds      |
| Vercel CLI          | `59.1.3`                     | optional manual web deployments       |

Next.js 16 requires Node 20.9 or newer. Expo SDK 57 requires Node 22.13 or newer. Node 24 LTS satisfies both and is available on Vercel. Review these pins as a normal dependency-maintenance task; do not silently float production tooling to `latest`.

## Environment separation

Use independent staging and production projects. Never point a preview deployment at the production database unless the product owner explicitly approves that risk.

| Runtime               | Configuration location                    | Values                                                                                                                                 |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel web            | Vercel environment settings               | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, preview flag fixed to `false`                                             |
| Expo mobile           | EAS `preview` / `production` environments | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`                                                                            |
| Supabase Edge         | Supabase project secrets                  | service credentials, encryption key, provider secrets, Tigris and Brevo values                                                         |
| Trigger.dev           | Trigger.dev environment settings          | Supabase service values, encryption key, Brevo, Meta version and Tigris/recording values                                               |
| Deployment automation | protected CI environment secrets          | Supabase access token/project ID/database password, Trigger access token, Expo token or Vercel token only where CLI deployment is used |

`NEXT_PUBLIC_*` and `EXPO_PUBLIC_*` values are compiled into client bundles. They are public by design. Service-role keys, provider credentials, access tokens and storage credentials must never use either prefix.

Validate a local ignored environment file without exposing values:

```bash
pnpm env:check:web
pnpm env:check:mobile
pnpm env:check:edge
pnpm env:check:trigger
```

The validator reports variable names and validation reasons only. `pnpm env:check:example` checks that the committed template contains no secret-like values.

An operator or protected deployment job can separately run `pnpm env:check:deployment` after supplying the Supabase and Trigger CLI credentials. Those credentials are intentionally absent from `.env.example` because they are not application runtime configuration.

## 1. Verify the release candidate

Install exactly from the lockfile and run all checks:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm mobile:doctor
```

`pnpm verify` includes formatting, ESLint, strict TypeScript, mobile TypeScript, API/backend tests, Supabase function-boundary configuration, all Deno Edge entrypoints and a Next.js Webpack production build. It intentionally has no UI automation.

Run the Supabase migration chain locally before any remote push:

```bash
pnpm supabase:local:start
pnpm supabase:local:reset
pnpm dlx supabase@2.114.0 db lint --local --level error --fail-on error
```

The local database commands require Docker; it is not part of `pnpm verify`. If Docker is unavailable, the CI migration job is still mandatory; lack of a successful fresh-chain run is a release blocker.

## 2. Deploy Supabase first

Take a database backup or confirm the configured recovery mechanism before applying migrations. Test staging first. Production migrations should be additive/backward-compatible where practical; prefer a forward fix over an unreviewed destructive rollback.

Authenticate and link the intended project explicitly:

```bash
pnpm supabase:link -- --project-ref PROJECT_REF
pnpm dlx supabase@2.114.0 migration list
pnpm supabase:db:push
pnpm dlx supabase@2.114.0 migration list
```

Upload Edge runtime secrets from a dedicated ignored file. Review the filename and target project before running this state-changing command:

```bash
pnpm dlx supabase@2.114.0 secrets set --project-ref PROJECT_REF --env-file .env.edge.production
```

Then deploy the focused Edge Functions. `supabase/config.toml` is the source of truth for gateway JWT verification; `pnpm check:supabase-config` must pass immediately before deployment.

```bash
pnpm supabase:functions:deploy -- --project-ref PROJECT_REF
```

Post-deploy checks:

- confirm migration versions match the release commit
- confirm only the five explicitly allowlisted public boundaries have `verify_jwt = false`
- verify webhook challenges/signatures and OAuth callback URLs with staging provider assets
- verify an authenticated allowed request and a denied cross-tenant request for every changed function family
- verify audit/error records are sanitized and no secret is returned

Provider callback configuration:

- Configure the Meta app Lead Ads callback as
  `PUBLIC_EDGE_FUNCTION_BASE_URL/provider-webhook-meta` and the WhatsApp product callback as
  `PUBLIC_EDGE_FUNCTION_BASE_URL/provider-webhook-whatsapp`. These are application-level URLs;
  do not append a tenant or connection ID. Signed payload Page/phone identifiers are resolved
  through the unique active tenant asset mapping.
- Configure each Google Ads lead form callback with the connection-specific URL returned by the
  integration workflow and its separate anti-spoofing key.
- In staging, prove that an unknown Page/phone is acknowledged without creating a tenant event,
  while each mapped asset creates a `RECEIVED` event only for its owning tenant.

## 3. Deploy Trigger.dev tasks

Configure task runtime values in the matching Trigger.dev environment. The deploy CLI uses `TRIGGER_ACCESS_TOKEN`; task executions use that environment's `TRIGGER_SECRET_KEY` and runtime variables.

Build without deploying first:

```bash
pnpm trigger:deploy:dry-run
```

Deploy and observe staging:

```bash
pnpm trigger:deploy:staging
```

Confirm that `provider-event-dispatch` runs every minute with task concurrency `1`, claims only a
bounded batch, and advances receipts through `PROCESSING` to `PROCESSED`, `UNMAPPED`, `RETRY`, or
`FAILED`. Exercise a stale lease and an out-of-order WhatsApp status callback before promotion.

For production, create an unpromoted candidate so the built version can be reviewed:

```bash
pnpm trigger:deploy:production:candidate
```

Promote the reviewed version using the exact version emitted by the candidate deployment:

```bash
pnpm dlx trigger.dev@4.5.11 promote DEPLOYMENT_VERSION
```

Confirm the provider outbox, recording ingestion, retention purge and support-session expiry schedules are registered. Trigger.dev schedules replace Vercel cron for these jobs.

## 4. Deploy the Vercel web application

Vercel detects Next.js using `vercel.json`, installs with the frozen pnpm lockfile and runs `pnpm build:vercel`. The build fails when required public Supabase configuration is absent or malformed.

The preferred release path is Vercel's Git integration after required CI checks pass. For an explicitly authorized CLI deployment:

```bash
pnpm vercel:deploy:preview
pnpm vercel:deploy:production
```

Configure the production `/auth/callback` URL in the Supabase Auth redirect allowlist before promotion. Provider APIs remain behind Supabase Edge Functions; do not copy provider/service secrets into Vercel merely for convenience.

Vercel Hobby is for personal, non-commercial use. A commercial dealership production deployment must use an eligible Vercel plan or another approved host; free-tier assumptions are suitable only for a non-commercial prototype within provider limits.

## 5. Build the Expo mobile application

`mobile/eas.json` defines internal preview and store production profiles and selects the matching EAS environment. Before the first build, an authorized Expo owner must link the app with `eas init`; the generated `extra.eas.projectId` must be reviewed and committed. Do not invent or copy a project ID from another app.

Create `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in both EAS environments. These values are public; never add service-role or provider credentials to the mobile environment.

Build and manually verify the internal release first:

```bash
pnpm mobile:doctor
pnpm mobile:build:preview
```

After QR linking, MFA, offline state, route buffering and background-location flows pass on real devices, create store artifacts:

```bash
pnpm mobile:build:production
```

Store submission is intentionally separate from building. Review signing identities, store metadata, privacy declarations and release notes before using `eas submit`.

## Rollback and recovery

- Vercel: promote the last known-good deployment; public build-time variables require a new build when changed.
- Trigger.dev: promote the last known-good task version. Running task attempts remain version-locked.
- Edge Functions: deploy the last known-good function source from a reviewed commit after checking schema compatibility.
- PostgreSQL: do not improvise a down migration against business data. Stop traffic if necessary, assess the backup/recovery point and apply a reviewed forward fix or restore plan.
- Expo: halt store rollout or restore the prior store version. Do not publish an over-the-air update until the project deliberately configures and tests EAS Update compatibility.

## Current external setup blockers

These require account ownership or verified external state and cannot be completed by repository changes alone:

- the linked Supabase project has all migrations through `202608150031` and all 27 configured Edge Functions active; tenant/auth fixtures and authenticated cross-tenant smoke tests are still required
- a full fresh Docker/CI reset remains a required release gate even though the linked remote migration chain applied successfully
- the current production dependency audit reports 2 high and 2 moderate findings in Expo/Metro's transitive `image-size@1.2.1` path. The advisory names `>=2.0.3` as fixed, but that version is not currently published to the registry; track the Expo/Metro upstream release or document a time-bounded accepted risk before release
- Vercel, Trigger.dev and EAS projects must be linked by their owners with protected environment variables
- `mobile/app.json` does not yet contain an authorized EAS project ID
- Meta/Google/WhatsApp production apps, permissions, reviewed redirect/webhook URLs and branch asset mappings require provider-console setup
- production `INTEGRATION_ENCRYPTION_KEY` and any missing provider credentials must be generated/stored server-side
- Brevo SMTP/domain/template approval and Tigris private-bucket policy require provider-console verification
- live CRM modules, behavioral RLS/API coverage and manual screenshot/acceptance QA must reach the product-wide Definition of Done before launch

## Official references

- [Next.js deployment](https://nextjs.org/docs/app/getting-started/deploying)
- [Vercel project configuration](https://vercel.com/docs/project-configuration)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Supabase deployment and branching](https://supabase.com/docs/guides/deployment)
- [Supabase Edge Function deployment](https://supabase.com/docs/guides/functions/deploy)
- [Trigger.dev deployment](https://trigger.dev/docs/deployment/overview)
- [Expo EAS build configuration](https://docs.expo.dev/build/eas-json/)
- [Expo EAS environment variables](https://docs.expo.dev/eas/environment-variables/)
