# AI credit roadmap

## Implemented now

- A Super Admin with a valid MFA assurance level is the only actor who can allocate platform-funded AI credits.
- Every allocation is an immutable positive `AI` ledger entry, has an idempotency request ID, and produces an audit-log entry.
- CRM-managed call transcription, cleanup, summary, and extraction consume tenant AI product credits in the background worker whether the request uses the platform provider or the tenant's own verified Groq connection. The billing mode records who pays the upstream provider; it does not bypass the CRM credit meter.
- Each call-transcription and call-analysis phase reserves credits idempotently before external AI work, commits them after its durable result is saved, and reverses any still-reserved credits when bounded retries are exhausted.
- Business Owners can view their organization's AI credit summary, but cannot allocate, edit, or delete credits.
- Image generation currently requires the tenant's own supported provider connection, so it has no platform-credit charge yet.

## Next credit milestones

1. Add a versioned rate card and store a price/credit snapshot on every CRM-metered AI operation.
2. Add optional platform-managed image generation with explicit per-image credit reservation and settlement.
3. Add consolidated tenant usage, limits, alerts, and invoice/export reporting.
4. Extend the same immutable-ledger model to future agent, messaging, and tracking usage once each operation has an approved rate card.

No provider cost is estimated in the product until an approved, versioned rate card exists.
