import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import { leadTemperatureVariant } from '@/features/leads/lead-temperature-variant';
import { humanizeEnum } from '@/lib/format';

/**
 * One meaning per colour across every department: red needs someone to act,
 * amber is waiting on someone, green is done, blue is new or live, grey is
 * closed or not applicable. Statuses are matched by exact key, because the old
 * substring test painted "Inactive" blue for containing "active" and left every
 * department's own end state (Disbursed, Policy issued, Registered, Delivered)
 * grey while "Completed" was green.
 */
const statusVariants: Record<string, BadgeVariant> = {
  // Needs action
  FAILED: 'destructive',
  OVERDUE: 'destructive',
  REJECTED: 'destructive',
  URGENT: 'destructive',
  SLA_BREACHED: 'destructive',
  NEEDS_ATTENTION: 'destructive',
  LOCKED: 'destructive',
  DOWN: 'destructive',
  NO_SHOW: 'destructive',
  SUSPENDED: 'destructive',
  CHANGES_REQUIRED: 'destructive',
  ESCALATED: 'destructive',
  // Waiting on someone
  PENDING: 'warning',
  HIGH: 'warning',
  IN_PROGRESS: 'warning',
  IN_PROCESS: 'warning',
  PROCESSING: 'warning',
  RUNNING: 'warning',
  QUEUED: 'warning',
  RETRY: 'warning',
  UNDER_REVIEW: 'warning',
  UNDER_EVALUATION: 'warning',
  DOCUMENTS_PENDING: 'warning',
  APPLICATION_SUBMITTED: 'warning',
  SUBMITTED: 'warning',
  AWAITING: 'warning',
  REQUIRED: 'warning',
  MANUAL: 'warning',
  DRAFT: 'warning',
  PAUSED: 'warning',
  HOLD: 'warning',
  ON_HOLD: 'warning',
  IN_TRANSIT: 'warning',
  RESERVED: 'warning',
  RESCHEDULED: 'warning',
  NOT_ARRIVED: 'warning',
  WARNING: 'warning',
  DEGRADED: 'warning',
  STALE: 'warning',
  RETURNED: 'warning',
  ONBOARDING: 'warning',
  // Done
  COMPLETED: 'success',
  APPROVED: 'success',
  ACCEPTED: 'success',
  RESOLVED: 'success',
  DELIVERED: 'success',
  DISBURSED: 'success',
  POLICY_ISSUED: 'success',
  REGISTERED: 'success',
  NUMBER_ALLOCATED: 'success',
  VALUATION_READY: 'success',
  READY: 'success',
  READY_FOR_DELIVERY: 'success',
  ALLOCATED: 'success',
  AVAILABLE: 'success',
  HEALTHY: 'success',
  ENABLED: 'success',
  PUBLISHED: 'success',
  SENT: 'success',
  CONFIRMED: 'success',
  ARRIVED: 'success',
  FILLED: 'success',
  LINKED: 'success',
  MAPPED: 'success',
  // New or live
  NEW: 'info',
  OPEN: 'info',
  ACTIVE: 'info',
  CONNECTED: 'info',
  SCHEDULED: 'info',
  ASSIGNED: 'info',
  CREATED: 'info',
  INCOMING: 'info',
  CUSTOMER_CONTACTED: 'info',
  NORMAL: 'info',
};

const temperatures = new Set(['HOT', 'WARM', 'COLD', 'DORMANT']);

const leadStages = new Set([
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Follow-up',
  'Test Drive',
  'Quotation',
  'Booking',
  'Lost',
  'NEW_TODAY',
  'SLA_RISK',
]);

export function statusVariant(value: string): BadgeVariant {
  // Lead stages keep the one stage palette (AGENTS.md 9.8). PENDING is both a
  // lead work-state and a case status, and amber-family reads right for both.
  if (leadStages.has(value)) return leadStageVariant(value);
  if (temperatures.has(value)) return leadTemperatureVariant(value);
  const key = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return statusVariants[key] ?? 'secondary';
}

export function StatusBadge({ value }: { value: string }) {
  return (
    <Badge variant={statusVariant(value)} className="rounded px-2 py-0 text-[11px]">
      {leadStages.has(value) ? value : humanizeEnum(value)}
    </Badge>
  );
}
