'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
  fetchWorkCreateOptions,
  updateAppointment,
  updateFollowup,
  type AppointmentRecord,
  type FollowupRecord,
  type WorkEntityOption,
  type WorkRecord,
  type WorkUserOption,
} from './workspace-api';
import { isWorkVersionConflict, type WorkKind } from './workspace-query';

const followupReasons = [
  'Customer Callback',
  'Test Drive Confirmation',
  'Quotation Discussion',
  'Price Negotiation',
  'Stock Update',
  'Exchange Update',
  'Booking Confirmation',
  'Document Reminder',
  'General Follow-up',
] as const;

function safeMutationMessage(error: unknown) {
  if (isWorkVersionConflict(error))
    return 'This record changed after you opened it. Refresh the worklist and try again.';
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: string }).message;
    const safeMessages: Record<string, string> = {
      NO_CHANGES: 'No changes were made.',
      ASSIGNEE_SCOPE_DENIED: 'The selected user cannot receive this work item.',
      ASSIGN_PERMISSION_REQUIRED: 'You are not allowed to reassign this work item.',
      APPOINTMENT_NOT_DUE: 'A future appointment cannot be marked as no-show.',
      APPOINTMENT_TERMINAL: 'This appointment is already closed.',
      FOLLOWUP_TERMINAL: 'This follow-up is already closed.',
      SCOPE_DENIED: 'This record is outside your current data scope.',
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
}: {
  kind: WorkKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [selectedEntityKey, setSelectedEntityKey] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');
  const [scheduledAt, setScheduledAt] = useState(defaultLocalDateTime);
  const [reason, setReason] = useState<(typeof followupReasons)[number]>('Customer Callback');
  const [priority, setPriority] = useState<'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [appointmentType, setAppointmentType] = useState<'Showroom Visit' | 'Test Drive'>(
    'Showroom Visit',
  );
  const [notes, setNotes] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: ['work-create-options', kind, debouncedSearch],
    queryFn: () => fetchWorkCreateOptions(kind, debouncedSearch),
    enabled: open,
    staleTime: 60_000,
  });
  const selectedEntity = options.data?.entities.find(
    (entity) => entityKey(entity) === selectedEntityKey,
  );
  const availableUsers = useMemo(
    () => usersForEntity(options.data?.users ?? [], selectedEntity),
    [options.data?.users, selectedEntity],
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedEntity) throw new Error('ENTITY_REQUIRED');
      const assignee = assignedUserId || selectedEntity.default_assigned_user_id;
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
            The branch and team come from the selected authorized customer context.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={`${kind}-entity-search`}>Find customer</Label>
            <Input
              id={`${kind}-entity-search`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Customer name or phone"
              maxLength={160}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Customer / lead</Label>
            <Select
              value={selectedEntityKey}
              onValueChange={(value) => {
                setSelectedEntityKey(value);
                const entity = options.data?.entities.find((item) => entityKey(item) === value);
                setAssignedUserId(entity?.default_assigned_user_id ?? '');
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={options.isFetching ? 'Loading authorized records…' : 'Select record'}
                />
              </SelectTrigger>
              <SelectContent>
                {(options.data?.entities ?? []).map((entity) => (
                  <SelectItem key={entityKey(entity)} value={entityKey(entity)}>
                    {entityLabel(entity)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options.isError && (
              <p className="text-xs text-destructive">
                Authorized customer options are unavailable. Reference: GDM-WORK-OPTIONS.
              </p>
            )}
          </div>
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
          <div className="space-y-2">
            <Label>Assigned user</Label>
            <Select
              value={assignedUserId}
              onValueChange={setAssignedUserId}
              disabled={!selectedEntity || availableUsers.length === 0}
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
          {kind === 'followups' ? (
            <>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Select
                  value={reason}
                  onValueChange={(value) => setReason(value as (typeof followupReasons)[number])}
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
                <Select
                  value={appointmentType}
                  onValueChange={(value) =>
                    setAppointmentType(value as 'Showroom Visit' | 'Test Drive')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Showroom Visit">Showroom Visit</SelectItem>
                    <SelectItem value="Test Drive">Test Drive</SelectItem>
                  </SelectContent>
                </Select>
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
          <Button onClick={submit} disabled={mutation.isPending || options.isFetching}>
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
    queryKey: ['work-edit-options', kind, record.id],
    queryFn: () => fetchWorkCreateOptions(kind),
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
      const nextIso = new Date(scheduledAt).toISOString();
      if (followup) {
        const patch: Parameters<typeof updateFollowup>[0]['patch'] = {};
        if (reason.trim() !== followup.reason) patch.reason = reason;
        if (new Date(nextIso).getTime() !== new Date(followup.due_at).getTime())
          patch.due_at = nextIso;
        if (priority !== followup.priority) patch.priority = priority;
        if (assignedUserId !== followup.assigned_user_id) patch.assigned_user_id = assignedUserId;
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
        patch.appointment_type = appointmentType as 'Showroom Visit' | 'Test Drive';
      if (new Date(nextIso).getTime() !== new Date(appointment.scheduled_at).getTime())
        patch.scheduled_at = nextIso;
      if (notes.trim() !== (appointment.notes ?? '')) patch.notes = notes;
      if (assignedUserId !== appointment.assigned_user_id) patch.assigned_user_id = assignedUserId;
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
            Saving uses version {record.version}; stale edits are rejected safely.
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
                  onValueChange={(value) =>
                    setAppointmentType(value as 'Showroom Visit' | 'Test Drive')
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Showroom Visit">Showroom Visit</SelectItem>
                    <SelectItem value="Test Drive">Test Drive</SelectItem>
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
  const mutation = useMutation({
    mutationFn: () => {
      const input = {
        kind,
        id: record.id,
        expectedVersion: record.version,
        requestId: crypto.randomUUID(),
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
            {action === 'complete' ? 'Complete work item' : 'Cancel work item'}
          </DialogTitle>
          <DialogDescription>
            {record.customer_name} · Version {record.version}. This action is audited.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <Label htmlFor={`${action}-work-note`}>
            {action === 'complete' ? 'Completion note (optional)' : 'Cancellation reason'}
          </Label>
          <Textarea
            id={`${action}-work-note`}
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
