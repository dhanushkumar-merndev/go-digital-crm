'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  cancelWork,
  completeWork,
  createAppointment,
  createFollowup,
  fetchLeadUpdatedAt,
  fetchWorkCreateOptions,
  updateAppointment,
  updateFollowup,
  type AppointmentRecord,
  type FollowupOutcome,
  type FollowupRecord,
  type WorkEntityOption,
  type WorkRecord,
  type WorkUserOption,
} from './workspace-api';
import { SearchSelect } from '@/components/ui/search-select';
import { salesConsultantKeys } from '@/features/sales-consultant/sales-consultant-cache';
import { optionQueryOptions } from '@/lib/query/option-query';
import { updateLead } from '@/features/leads/lead-workspace-api';
import {
  isWorkVersionConflict,
  schedulableAppointmentTypes,
  type SchedulableAppointmentType,
  type WorkKind,
} from './workspace-query';

// Telecallers work a callback queue, not a deal pipeline, so the stage-specific
// templates (test drive, quotation, negotiation, booking, documents) were noise
// on every follow-up they scheduled. Reasons are free text in the database, so
// follow-ups already saved under a retired template keep their stored reason.
export const followupReasons = ['Customer Callback', 'General Follow-up'] as const;
export type FollowupReason = (typeof followupReasons)[number];

/**
 * The types a consultant can actually book from Appointments. A test drive is
 * scheduled in the Test Drives module instead, because only that path records
 * the vehicle, registration, route and feedback the drive is made of.
 */
export const appointmentTypes = schedulableAppointmentTypes;
export type AppointmentType = SchedulableAppointmentType;

function safeMutationMessage(error: unknown) {
  if (isWorkVersionConflict(error))
    return 'This record changed after you opened it. Refresh the worklist and try again.';
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: string }).message;
    const safeMessages: Record<string, string> = {
      NO_CHANGES: 'No changes were made.',
      WORK_REQUEST_TIMEOUT:
        'The request is taking too long. The result is not yet confirmed. Retry with the same reason to safely check the cancellation.',
      CANCELLATION_REASON_REQUIRED: 'Enter a cancellation reason between 3 and 500 characters.',
      ASSIGNEE_SCOPE_DENIED: 'The selected user cannot receive this work item.',
      ASSIGN_PERMISSION_REQUIRED: 'You are not allowed to reassign this work item.',
      APPOINTMENT_NOT_DUE: 'A future appointment cannot be marked as no-show.',
      APPOINTMENT_TERMINAL: 'This appointment is already closed.',
      FOLLOWUP_TERMINAL: 'This follow-up is already closed.',
      SCOPE_DENIED: 'This record is outside your current data scope.',
      PERMISSION_DENIED:
        'You no longer have permission to change this work item. Refresh the list.',
      WORK_LEAD_NOT_IN_ORGANIZATION:
        'The linked lead is no longer available. Close this dialog and refresh the list.',
      INVALID_FOLLOWUP_DUE_AT: 'Choose a follow-up time from now to within the next two years.',
      INVALID_FOLLOWUP_REASON: 'Enter a follow-up reason between 3 and 240 characters.',
      INVALID_APPOINTMENT_TIME: 'Choose an appointment time from now to within the next two years.',
      INVALID_DATE_TIME: 'Enter a valid date and time.',
    };
    if (message && safeMessages[message]) return safeMessages[message];
  }
  return 'The work item could not be saved. Reference: GDM-WORK-MUTATION.';
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultLocalDateTime() {
  return toLocalDateTime(new Date(Date.now() + 60 * 60_000).toISOString());
}

function entityKey(entity: WorkEntityOption) {
  return `${entity.lead_id ?? 'customer'}:${entity.customer_id ?? 'unlinked'}:${entity.branch_id}`;
}

function entityLabel(entity: WorkEntityOption) {
  const model = entity.interested_model ? ` · ${entity.interested_model}` : '';
  const phone = entity.phone ? ` · ${entity.phone}` : '';
  return `${entity.customer_name}${phone}${model} · ${entity.branch_name}`;
}

function usersForEntity(users: WorkUserOption[], entity: WorkEntityOption | undefined) {
  if (!entity) return [];
  const byId = new Map<string, WorkUserOption>();
  for (const user of users) {
    if (user.branch_id !== entity.branch_id) continue;
    if (entity.team_id && user.team_id !== entity.team_id) continue;
    byId.set(user.id, user);
  }
  return [...byId.values()];
}

export function WorkCreateDialog({
  kind,
  open,
  onOpenChange,
  onCreated,
  initialEntity,
  initialFollowupReason,
  initialAppointmentType,
  lockInitialEntity = false,
}: {
  kind: WorkKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  initialEntity?: {
    leadId: string | null;
    customerId: string | null;
    branchId: string;
    teamId?: string | null;
    assignedUserId: string | null;
    assignedUserName?: string | null;
    customerName?: string;
    phone?: string | null;
    interestedModel?: string | null;
    search?: string;
    label?: string;
  };
  initialFollowupReason?: FollowupReason;
  initialAppointmentType?: AppointmentType;
  lockInitialEntity?: boolean;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const isSalesConsultant = workspaceSession?.roleKey === 'sales-consultant';
  const [search, setSearch] = useState(() => initialEntity?.search ?? '');
  const debouncedSearch = useDebouncedValue(search, 300);
  const hasSearchTerm = debouncedSearch.trim().length >= 2;
  const [selectedEntityKey, setSelectedEntityKey] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');
  const [scheduledAt, setScheduledAt] = useState(defaultLocalDateTime);
  const [reason, setReason] = useState<FollowupReason>(
    () => initialFollowupReason ?? 'Customer Callback',
  );
  const [priority, setPriority] = useState<'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [appointmentType, setAppointmentType] = useState<AppointmentType>(
    () => initialAppointmentType ?? 'Showroom Visit',
  );
  const [notes, setNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const options = useQuery(
    optionQueryOptions({
      queryKey: [...salesConsultantKeys.workCreateOptions(queryScope), kind, debouncedSearch],
      queryFn: ({ signal }) => fetchWorkCreateOptions(kind, debouncedSearch, signal),
      enabled: open && !lockInitialEntity && hasSearchTerm,
    }),
  );
  // Retained across searches: the assignee list, the branch and the submit
  // payload all read from the picked entity, so losing it to the next search
  // page silently reset the rest of the form.
  const [pickedEntity, setPickedEntity] = useState<WorkEntityOption | null>(null);
  const lockedEntity = useMemo<WorkEntityOption | undefined>(() => {
    if (!open || !lockInitialEntity || !initialEntity) return undefined;
    return {
      lead_id: initialEntity.leadId,
      customer_id: initialEntity.customerId,
      customer_name: initialEntity.customerName ?? 'Selected customer',
      phone: initialEntity.phone ?? null,
      interested_model: initialEntity.interestedModel ?? null,
      branch_id: initialEntity.branchId,
      branch_name: 'Selected branch',
      team_id: initialEntity.teamId ?? null,
      team_name: null,
      default_assigned_user_id: initialEntity.assignedUserId,
    };
  }, [initialEntity, lockInitialEntity, open]);
  const initialEntityOption = useMemo(() => {
    if (!open || lockInitialEntity || !initialEntity) return undefined;
    return options.data?.entities.find(
      (candidate) =>
        candidate.lead_id === initialEntity.leadId &&
        candidate.customer_id === initialEntity.customerId &&
        candidate.branch_id === initialEntity.branchId,
    );
  }, [initialEntity, lockInitialEntity, open, options.data?.entities]);
  const resolvedEntityKey =
    selectedEntityKey || (initialEntityOption ? entityKey(initialEntityOption) : '');
  const selectedEntity =
    lockedEntity ??
    options.data?.entities.find((entity) => entityKey(entity) === resolvedEntityKey) ??
    (pickedEntity && entityKey(pickedEntity) === resolvedEntityKey ? pickedEntity : undefined);
  const resolvedAssignedUserId =
    (assignedUserId ||
      (lockedEntity === selectedEntity || initialEntityOption === selectedEntity
        ? initialEntity?.assignedUserId || selectedEntity?.default_assigned_user_id
        : selectedEntity?.default_assigned_user_id)) ??
    '';
  const effectiveAssignedUserId = isSalesConsultant
    ? (workspaceSession?.userId ?? resolvedAssignedUserId)
    : resolvedAssignedUserId;
  const entityOptions = useMemo(
    () =>
      hasSearchTerm
        ? options.data?.entities.map((entity) => ({
            value: entityKey(entity),
            label: entity.customer_name,
            description: [
              entity.phone ?? 'No phone',
              entity.interested_model ?? 'Vehicle TBD',
              entity.branch_name,
            ]
              .filter(Boolean)
              .join(' · '),
          }))
        : [],
    [hasSearchTerm, options.data?.entities],
  );
  const availableUsers = useMemo(() => {
    const users = usersForEntity(options.data?.users ?? [], selectedEntity);
    if (
      !selectedEntity ||
      !resolvedAssignedUserId ||
      users.some((user) => user.id === resolvedAssignedUserId)
    )
      return users;

    // A locked lead shortcut should always show its existing owner. The mutation
    // still enforces assignment scope server-side; this only prevents the select
    // from rendering blank while the candidate list is scoped or still refreshing.
    return [
      {
        id: resolvedAssignedUserId,
        name:
          initialEntity?.assignedUserName ?? workspaceSession?.displayName ?? 'Assigned consultant',
        branch_id: selectedEntity.branch_id,
        team_id: selectedEntity.team_id,
      },
      ...users,
    ];
  }, [
    initialEntity?.assignedUserName,
    options.data?.users,
    resolvedAssignedUserId,
    selectedEntity,
    workspaceSession?.displayName,
  ]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedEntity) throw new Error('ENTITY_REQUIRED');
      const assignee = effectiveAssignedUserId || selectedEntity.default_assigned_user_id;
      if (!assignee) throw new Error('ASSIGNEE_REQUIRED');
      if (!scheduledAt) throw new Error('SCHEDULE_REQUIRED');
      const scheduledIso = new Date(scheduledAt).toISOString();
      const requestId = crypto.randomUUID();
      return kind === 'followups'
        ? createFollowup({
            entity: selectedEntity,
            assignedUserId: assignee,
            reason,
            dueAt: scheduledIso,
            priority,
            requestId,
          })
        : createAppointment({
            entity: selectedEntity,
            assignedUserId: assignee,
            appointmentType,
            scheduledAt: scheduledIso,
            notes,
            requestId,
          });
    },
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setSelectedEntityKey('');
      setAssignedUserId('');
      setNotes('');
      setValidationError(null);
    },
  });

  const submit = () => {
    if (!selectedEntity) {
      setValidationError('Select a customer or lead first.');
      return;
    }
    if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
      setValidationError('Choose a valid date and time.');
      return;
    }
    setValidationError(null);
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {kind === 'followups' ? 'Schedule follow-up' : 'Schedule appointment'}
          </DialogTitle>
          <DialogDescription>
            {lockInitialEntity
              ? isSalesConsultant
                ? `The selected lead is fixed. Choose the ${
                    kind === 'followups' ? 'due time and follow-up details' : 'time'
                  }. This will be assigned to you.`
                : `The selected lead is fixed. Choose the ${
                    kind === 'followups'
                      ? 'due time, assignee and follow-up details'
                      : 'time and assignee'
                  }.`
              : 'The branch and team come from the selected authorized customer context.'}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {lockInitialEntity ? (
            <div className="space-y-2 sm:col-span-2">
              <Label>Customer / lead</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
                {selectedEntity
                  ? entityLabel(selectedEntity)
                  : (initialEntity?.label ?? 'Loading selected lead…')}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${kind}-entity-search`}>Customer / lead</Label>
                <SearchSelect
                  id={`${kind}-entity-search`}
                  value={resolvedEntityKey}
                  search={search}
                  onSearchChange={setSearch}
                  options={entityOptions}
                  isPending={hasSearchTerm && options.isPending}
                  isFetching={options.isFetching}
                  isError={options.isError}
                  placeholder="Select record"
                  searchPlaceholder="Type at least 2 letters or phone digits"
                  emptyMessage={
                    hasSearchTerm
                      ? 'No authorized customer or lead matches this search.'
                      : 'Type at least 2 characters to search your authorized records.'
                  }
                  aria-label="Customer or lead"
                  onValueChange={(value) => {
                    setSelectedEntityKey(value);
                    const entity =
                      options.data?.entities.find((item) => entityKey(item) === value) ?? null;
                    setPickedEntity(entity);
                    setAssignedUserId(entity?.default_assigned_user_id ?? '');
                  }}
                />
              </div>
            </>
          )}
          {options.isError && (
            <p className="text-xs text-destructive sm:col-span-2">
              Authorized customer options are unavailable. Reference: GDM-WORK-OPTIONS.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${kind}-scheduled-at`}>
              {kind === 'followups' ? 'Due at' : 'Scheduled at'}
            </Label>
            <Input
              id={`${kind}-scheduled-at`}
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              required
            />
          </div>
          {!isSalesConsultant && (
            <div className="space-y-2">
              <Label>Assigned user</Label>
              <Select
                value={resolvedAssignedUserId}
                onValueChange={setAssignedUserId}
                disabled={!selectedEntity || availableUsers.length <= 1}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select user" />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind === 'followups' ? (
            <>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Select
                  value={reason}
                  onValueChange={(value) => setReason(value as FollowupReason)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {followupReasons.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(value) =>
                    setPriority(value as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Appointment type</Label>
                {initialAppointmentType ? (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
                    {appointmentType}
                  </div>
                ) : (
                  <Select
                    value={appointmentType}
                    onValueChange={(value) => setAppointmentType(value as AppointmentType)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {appointmentTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="appointment-notes">Notes</Label>
                <Textarea
                  id="appointment-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={2000}
                  placeholder="Optional preparation or customer notes"
                />
              </div>
            </>
          )}
        </div>
        {(validationError || mutation.isError) && (
          <p className="mt-4 text-sm text-destructive">
            {validationError ?? safeMutationMessage(mutation.error)}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              mutation.isPending || options.isFetching || (lockInitialEntity && !selectedEntity)
            }
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WorkEditDialog({
  kind,
  record,
  open,
  onOpenChange,
  onUpdated,
}: {
  kind: WorkKind;
  record: WorkRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const isSalesConsultant = workspaceSession?.roleKey === 'sales-consultant';
  const isFollowup = kind === 'followups' && 'due_at' in record;
  const followup = isFollowup ? (record as FollowupRecord) : null;
  const appointment = !isFollowup ? (record as AppointmentRecord) : null;
  const [scheduledAt, setScheduledAt] = useState(
    toLocalDateTime(followup?.due_at ?? appointment?.scheduled_at ?? new Date().toISOString()),
  );
  const [reason, setReason] = useState(followup?.reason ?? 'General Follow-up');
  const [priority, setPriority] = useState(followup?.priority ?? 'NORMAL');
  const [appointmentType, setAppointmentType] = useState(
    appointment?.appointment_type ?? 'Showroom Visit',
  );
  const [notes, setNotes] = useState(appointment?.notes ?? '');
  const [status, setStatus] = useState(appointment?.status ?? 'SCHEDULED');
  const [attendance, setAttendance] = useState(appointment?.attendance_status ?? 'NOT_ARRIVED');
  const [assignedUserId, setAssignedUserId] = useState(record.assigned_user_id);
  const options = useQuery({
    queryKey: ['work-edit-options', ...queryScope, kind, record.id],
    queryFn: ({ signal }) => fetchWorkCreateOptions(kind, '', signal),
    enabled: open,
    staleTime: 60_000,
  });
  const entity: WorkEntityOption = {
    lead_id: record.lead_id,
    customer_id: record.customer_id,
    customer_name: record.customer_name,
    phone: record.phone,
    interested_model: record.interested_model,
    branch_id: record.branch_id,
    branch_name: record.branch_name,
    team_id: record.team_id,
    team_name: record.team_name,
    default_assigned_user_id: record.assigned_user_id,
  };
  const availableUsers = usersForEntity(options.data?.users ?? [], entity);
  if (!availableUsers.some((user) => user.id === record.assigned_user_id))
    availableUsers.unshift({
      id: record.assigned_user_id,
      name: record.assigned_user_name,
      branch_id: record.branch_id,
      team_id: record.team_id,
    });

  const mutation = useMutation({
    mutationFn: () => {
      const requestId = crypto.randomUUID();
      if (!scheduledAt || !Number.isFinite(new Date(scheduledAt).getTime()))
        throw new Error('INVALID_DATE_TIME');
      const nextIso = new Date(scheduledAt).toISOString();
      if (followup) {
        const patch: Parameters<typeof updateFollowup>[0]['patch'] = {};
        if (reason.trim() !== followup.reason) patch.reason = reason;
        // datetime-local displays minutes. Do not turn an unchanged timestamp
        // with seconds into a reschedule, especially on an overdue follow-up.
        if (scheduledAt !== toLocalDateTime(followup.due_at)) patch.due_at = nextIso;
        if (priority !== followup.priority) patch.priority = priority;
        if (!isSalesConsultant && assignedUserId !== followup.assigned_user_id)
          patch.assigned_user_id = assignedUserId;
        if (!Object.keys(patch).length) throw new Error('NO_CHANGES');
        return updateFollowup({
          id: followup.id,
          expectedVersion: followup.version,
          patch,
          requestId,
        });
      }
      if (!appointment) throw new Error('APPOINTMENT_REQUIRED');
      const patch: Parameters<typeof updateAppointment>[0]['patch'] = {};
      if (appointmentType !== appointment.appointment_type)
        patch.appointment_type = appointmentType as AppointmentType;
      if (scheduledAt !== toLocalDateTime(appointment.scheduled_at)) patch.scheduled_at = nextIso;
      if (notes.trim() !== (appointment.notes ?? '')) patch.notes = notes;
      if (!isSalesConsultant && assignedUserId !== appointment.assigned_user_id)
        patch.assigned_user_id = assignedUserId;
      if (status !== appointment.status)
        patch.status = status as 'SCHEDULED' | 'CONFIRMED' | 'RESCHEDULED' | 'NO_SHOW';
      if (attendance !== appointment.attendance_status)
        patch.attendance_status = attendance as 'NOT_ARRIVED' | 'ARRIVED' | 'NO_SHOW';
      if (!Object.keys(patch).length) throw new Error('NO_CHANGES');
      return updateAppointment({
        id: appointment.id,
        expectedVersion: appointment.version,
        patch,
        requestId,
      });
    },
    onSuccess: () => {
      onUpdated();
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isFollowup ? 'Reschedule follow-up' : 'Update appointment'}</DialogTitle>
          <DialogDescription>
            {isFollowup
              ? 'Update the follow-up time, reason or priority.'
              : 'Update the appointment details and schedule.'}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>Customer</Label>
            <Input value={record.customer_name} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`edit-${kind}-scheduled`}>
              {isFollowup ? 'Due at' : 'Scheduled at'}
            </Label>
            <Input
              id={`edit-${kind}-scheduled`}
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </div>
          {!isSalesConsultant && (
            <div className="space-y-2">
              <Label>Assigned user</Label>
              <Select value={assignedUserId} onValueChange={setAssignedUserId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {followup ? (
            <>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={240}
                />
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(value) =>
                    setPriority(value as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Appointment type</Label>
                <Select
                  value={appointmentType}
                  onValueChange={(value) => setAppointmentType(value as AppointmentType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {appointmentTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={status}
                  onValueChange={(value) =>
                    setStatus(value as 'SCHEDULED' | 'CONFIRMED' | 'RESCHEDULED' | 'NO_SHOW')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SCHEDULED">Scheduled</SelectItem>
                    <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                    <SelectItem value="RESCHEDULED">Rescheduled</SelectItem>
                    <SelectItem value="NO_SHOW">No show</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Attendance</Label>
                <Select
                  value={attendance}
                  onValueChange={(value) =>
                    setAttendance(value as 'NOT_ARRIVED' | 'ARRIVED' | 'NO_SHOW')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NOT_ARRIVED">Not arrived</SelectItem>
                    <SelectItem value="ARRIVED">Arrived</SelectItem>
                    <SelectItem value="NO_SHOW">No show</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={2000}
                />
              </div>
            </>
          )}
        </div>
        {mutation.isError && (
          <p className="mt-4 text-sm text-destructive">{safeMutationMessage(mutation.error)}</p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !scheduledAt || !assignedUserId}
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WorkActionDialog({
  kind,
  action,
  record,
  open,
  onOpenChange,
  onCompleted,
}: {
  kind: WorkKind;
  action: 'complete' | 'cancel';
  record: WorkRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const [note, setNote] = useState('');
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      const fingerprint = JSON.stringify([kind, action, record.id, record.version, note.trim()]);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, requestId: crypto.randomUUID() };
      const input = {
        kind,
        id: record.id,
        expectedVersion: record.version,
        requestId: attempt.current.requestId,
      };
      return action === 'complete'
        ? completeWork({ ...input, note })
        : cancelWork({ ...input, reason: note });
    },
    onSuccess: () => {
      onCompleted();
      onOpenChange(false);
    },
  });
  const reasonRequired = action === 'cancel';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === 'complete'
              ? 'Complete work item'
              : kind === 'followups'
                ? 'Cancel follow-up'
                : 'Cancel appointment'}
          </DialogTitle>
          <DialogDescription>
            {record.customer_name}.{' '}
            {action === 'cancel'
              ? 'This will close the scheduled work and keep its history.'
              : 'Record the outcome of this work.'}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <Label htmlFor={`${action}-work-note`}>
            {action === 'complete' ? 'Completion note (optional)' : 'Cancellation reason'}
          </Label>
          <Textarea
            id={`${action}-work-note`}
            disabled={mutation.isPending}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={action === 'complete' ? 1000 : 500}
            placeholder={reasonRequired ? 'Required, at least 3 characters' : 'Optional'}
          />
        </div>
        {mutation.isError && (
          <p className="mt-4 text-sm text-destructive">{safeMutationMessage(mutation.error)}</p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep open
          </Button>
          <Button
            variant={action === 'cancel' ? 'destructive' : 'default'}
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (reasonRequired && note.trim().length < 3)}
          >
            {mutation.isPending
              ? 'Saving…'
              : action === 'complete'
                ? 'Mark complete'
                : 'Confirm cancellation'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const outcomeChoices = [
  {
    value: 'FOLLOW_UP' as const,
    label: 'Book another follow-up',
    hint: 'Still nurturing — schedule the next call now.',
  },
  {
    value: 'APPOINTMENT' as const,
    label: 'Book an appointment',
    hint: 'Customer agreed to come in or take a call.',
  },
  {
    value: 'LOST' as const,
    label: 'Mark lead lost',
    hint: 'Customer is gone. Needs a reason and is terminal.',
  },
  {
    value: 'TRANSFER_TO_SALES' as const,
    label: 'Transfer to Sales',
    hint: 'Customer is ready to talk to a Sales Consultant.',
  },
];

/**
 * Completing a follow-up asks what happens next, because this is the moment the
 * lead becomes movable: the Leads workspace refuses stage changes while a
 * follow-up is open, and clearing the last one drops the lead from the Follow-up
 * rung back onto Contacted. Closing without an answer left the lead looking like
 * it had gone backwards.
 *
 * The next record is created *before* the follow-up is completed. If the
 * consultant abandons the appointment form, or the write fails, the follow-up
 * stays open and the work is still on their list. The reverse order would leave
 * a follow-up marked "APPOINTMENT" with no appointment behind it — a promise the
 * data claims was kept.
 */
export function FollowupCompleteDialog({
  record,
  open,
  onOpenChange,
  onCompleted,
}: {
  record: FollowupRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const [outcome, setOutcome] = useState<FollowupOutcome | null>(null);
  const [note, setNote] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [chained, setChained] = useState<WorkKind | null>(null);
  const workspaceSession = useWorkspaceSession();
  const isTelecaller = workspaceSession?.roleKey === 'telecaller';

  const complete = useMutation({
    mutationFn: (chosen: FollowupOutcome) =>
      completeWork({
        kind: 'followups',
        id: record.id,
        expectedVersion: record.version,
        note,
        requestId: crypto.randomUUID(),
        outcome: chosen,
      }),
    onSuccess: () => {
      onCompleted();
      onOpenChange(false);
    },
  });

  const markLost = useMutation({
    mutationFn: async () => {
      if (!record.lead_id) throw new Error('FOLLOWUP_HAS_NO_LEAD');
      const expectedUpdatedAt = await fetchLeadUpdatedAt(record.lead_id);
      await updateLead({
        leadId: record.lead_id,
        expectedUpdatedAt,
        patch: { lifecycle_status: 'Lost', lost_reason: lostReason.trim() },
        reason: `Lost at follow-up: ${lostReason.trim()}`,
      });
      return completeWork({
        kind: 'followups',
        id: record.id,
        expectedVersion: record.version,
        note,
        requestId: crypto.randomUUID(),
        outcome: 'LOST',
      });
    },
    onSuccess: () => {
      onCompleted();
      onOpenChange(false);
    },
  });

  // A follow-up can hang off a customer with no lead. There is no opportunity to
  // lose in that case, so the option is offered but disabled rather than
  // silently failing on submit.
  const lostUnavailable = !record.lead_id;
  const busy = complete.isPending || markLost.isPending;
  const lostReasonTooShort = lostReason.trim().length < 3;
  const canSubmit =
    Boolean(outcome) && !busy && (outcome !== 'LOST' || (!lostUnavailable && !lostReasonTooShort));

  const entity = {
    leadId: record.lead_id,
    customerId: record.customer_id,
    branchId: record.branch_id,
    teamId: record.team_id,
    assignedUserId: record.assigned_user_id,
    assignedUserName: record.assigned_user_name,
    customerName: record.customer_name,
    phone: record.phone,
    interestedModel: record.interested_model,
    search: record.phone ?? record.customer_name,
    label: `${record.customer_name}${record.phone ? ` · ${record.phone}` : ''}`,
  };

  return (
    <>
      <Dialog open={open && !chained} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete follow-up</DialogTitle>
            <DialogDescription>
              {record.customer_name} · {record.reason}. Record what happens next so the lead does
              not fall back down the ladder.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label>What happens next?</Label>
            <div className="grid gap-2">
              {outcomeChoices
                .filter((c) => c.value !== 'TRANSFER_TO_SALES' || isTelecaller)
                .map((choice) => {
                const disabled = choice.value === 'LOST' && lostUnavailable;
                const active = outcome === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => setOutcome(choice.value)}
                    className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      active ? 'border-blue-400 bg-blue-50/60' : 'hover:border-blue-200'
                    }`}
                  >
                    <p className="text-sm font-semibold text-[#12213f]">{choice.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {disabled ? 'This follow-up is not linked to a lead.' : choice.hint}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
          {outcome === 'LOST' && !lostUnavailable && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="followup-lost-reason">Why was the lead lost?</Label>
              <Textarea
                id="followup-lost-reason"
                value={lostReason}
                onChange={(event) => setLostReason(event.target.value)}
                maxLength={500}
                placeholder="Required, at least 3 characters"
              />
            </div>
          )}
          <div className="mt-4 space-y-2">
            <Label htmlFor="followup-completion-note">Completion note (optional)</Label>
            <Textarea
              id="followup-completion-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              placeholder="What was discussed"
            />
          </div>
          {(complete.isError || markLost.isError) && (
            <p className="mt-4 text-sm text-destructive">
              {safeMutationMessage(complete.error ?? markLost.error)}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Keep open
            </Button>
            <Button
              disabled={!canSubmit}
              onClick={() => {
                if (outcome === 'LOST') markLost.mutate();
                else if (outcome === 'TRANSFER_TO_SALES') complete.mutate('TRANSFER_TO_SALES');
                else if (outcome)
                  setChained(outcome === 'FOLLOW_UP' ? 'followups' : 'appointments');
              }}
            >
              {busy
                ? 'Saving…'
                : outcome === 'LOST'
                  ? 'Mark lost and complete'
                  : outcome === 'TRANSFER_TO_SALES'
                    ? 'Complete follow-up'
                    : outcome === 'APPOINTMENT'
                      ? 'Next: book appointment'
                      : outcome === 'FOLLOW_UP'
                        ? 'Next: schedule follow-up'
                        : 'Choose an outcome'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {chained && (
        <WorkCreateDialog
          kind={chained}
          open
          lockInitialEntity
          initialEntity={entity}
          onOpenChange={(next) => {
            // Backing out of the next step leaves the follow-up open on purpose.
            if (!next) setChained(null);
          }}
          onCreated={() => {
            setChained(null);
            complete.mutate(chained === 'followups' ? 'FOLLOW_UP' : 'APPOINTMENT');
          }}
        />
      )}
    </>
  );
}
