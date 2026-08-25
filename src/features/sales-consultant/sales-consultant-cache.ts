'use client';

import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
  type WorkspaceSession,
} from '@/components/providers/workspace-session-provider';

/**
 * One place that owns every cache key a sales consultant reads, and the exact
 * set of keys each action has to refresh.
 *
 * Server data itself is NOT mirrored here: TanStack Query already holds it, and
 * a second copy in a client store would drift the moment a refetch, a realtime
 * event, or another tab moved one of them. What was actually missing is a
 * single definition of the keys and the action-to-key mapping, which was
 * previously spelled out by hand at every call site — inconsistently, and in
 * three places without the tenant scope, so one consultant's write invalidated
 * cached pages belonging to every other tenant in memory.
 */

type Scope = readonly [string, string, string];

export const salesConsultantKeys = {
  dashboard: (scope: Scope) => ['sales-consultant-dashboard', ...scope] as const,
  leadWorkspace: (scope: Scope) => ['lead-workspace', ...scope] as const,
  leadWorkspacePermissions: (scope: Scope) => ['lead-workspace-permissions', ...scope] as const,
  leadCreateOptions: (scope: Scope) => ['lead-create-options', ...scope] as const,
  leadAssignableUsers: (scope: Scope) => ['lead-assignable-users', ...scope] as const,
  leadAssignment: (scope: Scope) => ['lead-assignment', ...scope] as const,
  leadDetail: (leadId: string) => ['lead-detail', leadId] as const,
  personalLeadPreferences: (scope: Scope) =>
    ['personal-lead-preferences', scope[0], scope[1]] as const,
  customerWorkspace: (scope: Scope) => ['customer-workspace', ...scope] as const,
  customer360: (scope: Scope) => ['customer-360', ...scope] as const,
  callWorkspace: (scope: Scope) => ['call-workspace', ...scope] as const,
  callDetail: (callId: string) => ['call-detail', callId] as const,
  workWorkspace: (scope: Scope) => ['work-workspace', ...scope] as const,
  taskWorkspace: (scope: Scope) => ['task-workspace', ...scope] as const,
  followupCalendar: (scope: Scope) => ['followup-calendar', ...scope] as const,
  followupCalendarDay: (scope: Scope) => ['followup-calendar-day', ...scope] as const,
  appointmentCalendar: (scope: Scope) => ['appointment-calendar', ...scope] as const,
  appointmentCalendarDay: (scope: Scope) => ['appointment-calendar-day', ...scope] as const,
  appointmentTypeSummary: (scope: Scope) => ['appointment-type-summary', ...scope] as const,
  testDriveWorkspace: (scope: Scope) => ['test-drive-workspace', ...scope] as const,
  testDriveLeadOptions: (scope: Scope) => ['test-drive-lead-options', ...scope] as const,
  testDriveVehicleOptions: (scope: Scope) => ['test-drive-vehicle-options', ...scope] as const,
  salesDocumentWorkspace: (scope: Scope) => ['sales-document-workspace', ...scope] as const,
  bookingQuotationOptions: (scope: Scope) => ['booking-quotation-options', ...scope] as const,
  salesExchangeOptions: (scope: Scope) => ['sales-exchange-options', ...scope] as const,
  operationalCases: (scope: Scope) => ['operational-cases', scope[0]] as const,
  sharedInbox: (scope: Scope) => ['shared-inbox', ...scope] as const,
  sharedInboxMessages: (scope: Scope) => ['shared-inbox-messages', ...scope] as const,
  workCreateOptions: (scope: Scope) => ['work-create-options', ...scope] as const,
} as const;

/**
 * Actions a consultant can take. Naming them, rather than passing raw keys
 * around, is what keeps an action's fan-out reviewable in one diff.
 */
export type SalesConsultantAction =
  | 'lead.created'
  | 'lead.updated'
  | 'lead.assigned'
  | 'lead.preference.changed'
  | 'customer.updated'
  | 'call.logged'
  | 'followup.changed'
  | 'appointment.changed'
  | 'task.changed'
  | 'testdrive.changed'
  | 'quotation.changed'
  | 'exchange.changed'
  | 'inbox.message.sent';

type ActionContext = { leadId?: string; callId?: string };

/**
 * The dashboard is deliberately absent from every entry below. It is a cached
 * aggregate that only rebuilds on an explicit manual refresh, so invalidating
 * it here would spend a round trip to be handed back the identical Redis entry.
 */
const actionEffects: Record<
  SalesConsultantAction,
  (scope: Scope, context: ActionContext) => QueryKey[]
> = {
  'lead.created': (scope) => [
    salesConsultantKeys.leadWorkspace(scope),
    salesConsultantKeys.leadAssignment(scope),
  ],
  'lead.updated': (scope, context) => [
    salesConsultantKeys.leadWorkspace(scope),
    ...(context.leadId ? [salesConsultantKeys.leadDetail(context.leadId)] : []),
  ],
  'lead.assigned': (scope, context) => [
    salesConsultantKeys.leadWorkspace(scope),
    salesConsultantKeys.leadAssignment(scope),
    ...(context.leadId ? [salesConsultantKeys.leadDetail(context.leadId)] : []),
  ],
  // Pins and stars reorder the server-side page, so the rendered page is refetched.
  'lead.preference.changed': (scope) => [salesConsultantKeys.leadWorkspace(scope)],
  'customer.updated': (scope) => [
    salesConsultantKeys.customerWorkspace(scope),
    salesConsultantKeys.customer360(scope),
    salesConsultantKeys.leadWorkspace(scope),
  ],
  'call.logged': (scope, context) => [
    salesConsultantKeys.callWorkspace(scope),
    salesConsultantKeys.leadWorkspace(scope),
    ...(context.callId ? [salesConsultantKeys.callDetail(context.callId)] : []),
    ...(context.leadId ? [salesConsultantKeys.leadDetail(context.leadId)] : []),
  ],
  'followup.changed': (scope, context) => [
    salesConsultantKeys.workWorkspace(scope),
    salesConsultantKeys.workCreateOptions(scope),
    salesConsultantKeys.followupCalendar(scope),
    salesConsultantKeys.followupCalendarDay(scope),
    salesConsultantKeys.appointmentCalendar(scope),
    salesConsultantKeys.appointmentCalendarDay(scope),
    salesConsultantKeys.appointmentTypeSummary(scope),
    salesConsultantKeys.leadWorkspace(scope),
    salesConsultantKeys.customer360(scope),
    ...(context.leadId ? [salesConsultantKeys.leadDetail(context.leadId)] : []),
  ],
  // Follow-ups and appointments are two views over the same work records, so a
  // write to either has to settle both calendars and the shared summary.
  'appointment.changed': (scope, context) => [
    salesConsultantKeys.workWorkspace(scope),
    salesConsultantKeys.workCreateOptions(scope),
    salesConsultantKeys.appointmentCalendar(scope),
    salesConsultantKeys.appointmentCalendarDay(scope),
    salesConsultantKeys.appointmentTypeSummary(scope),
    salesConsultantKeys.followupCalendar(scope),
    salesConsultantKeys.followupCalendarDay(scope),
    salesConsultantKeys.leadWorkspace(scope),
    salesConsultantKeys.customer360(scope),
    ...(context.leadId ? [salesConsultantKeys.leadDetail(context.leadId)] : []),
  ],
  'task.changed': (scope) => [
    salesConsultantKeys.taskWorkspace(scope),
    salesConsultantKeys.customer360(scope),
  ],
  'testdrive.changed': (scope) => [
    salesConsultantKeys.testDriveWorkspace(scope),
    salesConsultantKeys.testDriveLeadOptions(scope),
    salesConsultantKeys.testDriveVehicleOptions(scope),
    salesConsultantKeys.customer360(scope),
  ],
  'quotation.changed': (scope) => [
    salesConsultantKeys.salesDocumentWorkspace(scope),
    salesConsultantKeys.bookingQuotationOptions(scope),
    salesConsultantKeys.customer360(scope),
  ],
  'exchange.changed': (scope) => [
    salesConsultantKeys.salesExchangeOptions(scope),
    salesConsultantKeys.operationalCases(scope),
    salesConsultantKeys.customer360(scope),
  ],
  'inbox.message.sent': (scope) => [
    salesConsultantKeys.sharedInbox(scope),
    salesConsultantKeys.sharedInboxMessages(scope),
  ],
};

export function salesConsultantActionKeys(
  session: WorkspaceSession | null,
  action: SalesConsultantAction,
  context: ActionContext = {},
) {
  return actionEffects[action](workspaceQueryScope(session), context);
}

/**
 * `invalidate` is fire-and-forget so a mutation's success handler never blocks
 * the UI on a refetch. `await settle` when a flow genuinely has to read back
 * the refreshed data, such as a wizard advancing to a summary step.
 */
export function useSalesConsultantCache() {
  const queryClient = useQueryClient();
  const session = useWorkspaceSession();
  const scope = useMemo(() => workspaceQueryScope(session), [session]);

  const settle = useCallback(
    (action: SalesConsultantAction, context: ActionContext = {}) =>
      Promise.all(
        actionEffects[action](scope, context).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
    [queryClient, scope],
  );

  const invalidate = useCallback(
    (action: SalesConsultantAction, context: ActionContext = {}) => {
      void settle(action, context);
    },
    [settle],
  );

  return { scope, keys: salesConsultantKeys, invalidate, settle };
}
