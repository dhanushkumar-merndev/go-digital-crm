# Shared vehicle comparison

One organization-level consent switch; no per-model visibility settings.

- Business Owner: Company & Compliance or Competitor Compare → Enable sharing → explicit confirmation.
- Private by default. Private organizations compare their own active variants only.
- Consent publishes all current/future active variants and unlocks other consenting organizations. Withdrawing either party's consent denies new search/detail/AI requests immediately. Open detail screens recheck every 15 seconds; previously viewed information cannot be recalled.
- Canonical source: vehicle brands/models/variants. Manufacturer, model, variant, dealership name, specifications and public ex-showroom price are projected. Internal insurance/registration/cost/margin pricing, stock, customer records and legacy competitor notes are not published.
- Existing private competitor profiles remain as reference notes, not global comparison records.
- Business Owner controls sharing. Existing master-data permissions still control updates to their own organization's models; cross-organization write permissions are never added.
- Standard specification inputs require a value or explicit `NOT_AVAILABLE`. Legacy incomplete rows remain readable as “Not specified”, not falsely marked absent. Custom fields are supported. Fuel and transmission controls and quotation price defaults are preserved.
- AI is initiated only by the user, costs 1 CRM AI credit, and uses an organization-wide connected OpenRouter `TEXT_GENERATION` model. Tenant provider charges may also apply. No connected model means no charge. Provider errors/timeouts are refunded; request IDs prevent double charges. Expired requests are refunded by minute-dispatch. Results are dealer-provided AI suggestions, not verified facts.
- Header balance is visible to authenticated tenant roles without granting ledger or allocation access. Platform users have no tenant balance.

## Release order

1. Review/apply migrations through `202609080006_vehicle_specs_ai_comparison.sql` (including the existing variant-pricing migration `202609080004`). Do not enable consent on behalf of an owner.
2. Deploy Edge Function `vehicle-comparison-ai` with JWT verification enabled.
3. Deploy Trigger.dev minute-dispatch for expired-request refunds.
4. Deploy web. Configure an organization-wide OpenRouter text connection through Integrations if needed.

No remote database writes, owner consent changes, paid AI calls or inventory mutations are part of the local validation run.

## Checks

`pnpm exec vitest run tests/api/shared-vehicle-comparison.test.ts tests/api/shared-vehicle-comparison-migration.test.ts tests/api/vehicle-comparison-ai-edge.test.ts`

The full-history test applies migrations in PGlite. Runtime tests cover mutual consent, default isolation, withdrawal, attribution, new/updated variants, role/MFA gates, standard/custom specs, replay-safe billing, refunds and provider failure. Inventory smoke checks authenticate only demo Inventory Manager/Executive users and perform read-only page/RPC requests.

Provider contract: [OpenRouter API reference](https://openrouter.ai/docs/api_reference/overview), [authentication](https://openrouter.ai/docs/api_reference/authentication), [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging), checked 2026-09-08. No hard-coded model identifier.
