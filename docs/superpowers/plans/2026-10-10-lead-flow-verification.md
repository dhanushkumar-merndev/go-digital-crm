# Lead flow verification and transport fixes

> **For agentic workers:** Use superpowers:executing-plans. Preserve the existing working-tree edits.

**Goal:** Verify the lead flow in a headed browser and fix demonstrated API transport gaps.

**Architecture:** Reuse the existing Supabase readRpc boundary and TanStack retry classifier. Keep transactional mutations unchanged.

**Tech stack:** Supabase, TanStack Query, Vitest, existing headed Playwright acceptance suite.

**Spec:** AGENTS.md sections 9, 11, 40 and 52; product owner's headed-testing request.

## Constraints and review focus

- Preserve tenant, record and sibling-lead access rules.
- Preserve customer linking decisions and atomic Sales handoff.
- Propagate caller cancellation; bound interactive reads to the existing ten-second deadline.
- Preserve HTTP errors so permission/validation failures are not retried.
- Check both successful empty responses and transient failures; never retry writes.

## Tasks

- [x] Run baseline API tests and headed acceptance suite with API timings.
- [x] Run a small read-only load baseline.
- [x] Add API transport regressions and observe failures before changing production code.
- [x] Route lead list, counters, history, preferences, selectors and detail through readRpc; apply retryRpcRead to their query consumers.
- [x] Run regression/API tests, lint, formatting, typecheck and build. API tests, scoped lint, formatting, typecheck and build pass; full-repository lint reports existing scratch-script errors.
- [ ] Finish and rerun headed acceptance flows as needed; record results and remaining limits.
