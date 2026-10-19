# AI credit roadmap

## Implemented now

- A Super Admin with a valid MFA assurance level is the only actor who can allocate platform-funded AI credits.
- Every allocation is an immutable positive `AI` ledger entry, has an idempotency request ID, and produces an audit-log entry.
- CRM-managed call transcription, translation, summary, and extraction run on the platform's Sarvam (speech-to-text with speaker separation) and Groq (translation, summary, suggestions) accounts and consume tenant AI product credits in the background worker. Tenant-connected Groq keys are not used for calls; the CRM credit meter is never bypassed.
- A call is priced by audio length: Sarvam's per-second cost (₹45/hour with diarization) plus the platform margin (30 %), at ₹1 per credit, rounded up, minimum 1 (`platform_ai_call_pricing`, `app_private.ai_call_credit_cost`). The worker holds the estimate before submitting to Sarvam, settles on the real length after the transcript arrives, commits only after the result is saved, and returns every hold when the job fails or exhausts its bounded retries.
- Business Owners can view their organization's AI credit summary, but cannot allocate, edit, or delete credits.
- Image generation currently requires the tenant's own supported provider connection, so it has no platform-credit charge yet.

## Next credit milestones

1. Add a versioned rate card and store a price/credit snapshot on every CRM-metered AI operation.
2. Add optional platform-managed image generation with explicit per-image credit reservation and settlement.
3. Add consolidated tenant usage, limits, alerts, and invoice/export reporting.
4. Extend the same immutable-ledger model to future agent, messaging, and tracking usage once each operation has an approved rate card.

No provider cost is estimated in the product until an approved, versioned rate card exists.
