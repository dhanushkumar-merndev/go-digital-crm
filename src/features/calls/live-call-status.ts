import { z } from 'zod';

/**
 * Statuses a provider call moves through. PENDING means TeleCMI accepted the
 * request but has not reported anything yet; RINGING and IN_PROGRESS come from
 * its webhooks; the rest are terminal.
 *
 * Kept free of client imports so the parsing rules stay unit-testable.
 */
export const liveCallStatuses = [
  'PENDING',
  'RINGING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type LiveCallStatus = (typeof liveCallStatuses)[number];

export function normalizeLiveCallStatus(value: string): LiveCallStatus {
  const normalized = value.toUpperCase();
  // A status the database grows later must not fail the parse and blank a bar
  // for a call that is actually ringing.
  return (liveCallStatuses as readonly string[]).includes(normalized)
    ? (normalized as LiveCallStatus)
    : 'PENDING';
}

export const liveCallSchema = z.object({
  call_id: z.uuid(),
  status: z.string().transform(normalizeLiveCallStatus),
  outcome: z.string().nullable(),
  lead_id: z.uuid().nullable(),
  customer_id: z.uuid().nullable(),
  customer_name: z.string(),
  phone: z.string().nullable(),
  started_at: z.string(),
  answered_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
});

export type LiveCall = z.infer<typeof liveCallSchema>;

export function isLiveCallStatus(status: LiveCallStatus) {
  return status === 'PENDING' || status === 'RINGING' || status === 'IN_PROGRESS';
}

/**
 * Prefix for every LiveCallBar query key. Whoever starts a call invalidates this
 * root so the bar appears the moment the edge function returns, instead of
 * waiting on a realtime broadcast round-trip that may be slow or dropped.
 */
export const liveCallQueryKeyRoot = ['live-call'] as const;
