# AI credit roadmap

## Implemented now

- A Super Admin with a valid MFA assurance level is the only actor who can allocate platform-funded AI credits.
- Every allocation is an immutable positive `AI` ledger entry, has an idempotency request ID, and produces an audit-log entry.
- Platform-managed call transcription, cleanup, summary, and extraction consume tenant AI credits in the background worker. A tenant's own Groq connection does not consume platform credits.
- Business Owners can view their organization's AI credit summary, but cannot allocate, edit, or delete credits.
- Image generation currently requires the tenant's own supported provider connection, so it has no platform-credit charge yet.

## Next credit milestones

1. Add a versioned rate card and store a price/credit snapshot on every platform-funded AI operation.
2. Use reserve, settle, and terminal-failure reversal entries so a failed provider operation never remains charged.
3. Add optional platform-managed image generation with explicit per-image credit reservation and settlement.
4. Add consolidated tenant usage, limits, alerts, and invoice/export reporting.
5. Extend the same immutable-ledger model to future agent, messaging, and tracking usage once each operation has an approved rate card.

No provider cost is estimated in the product until an approved, versioned rate card exists.
