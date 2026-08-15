'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
  cancelTask,
  completeTask,
  createTask,
  fetchTaskLeadOptions,
  updateTask,
  type TaskRecord,
} from './task-workspace-api';
import { isTaskVersionConflict } from './task-workspace-query';

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function TaskFormDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record?: TaskRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [leadId, setLeadId] = useState(record?.lead_id ?? '');
  const [leadSearch, setLeadSearch] = useState('');
  const [title, setTitle] = useState(record?.title ?? '');
  const [description, setDescription] = useState(record?.description ?? '');
  const [priority, setPriority] = useState(record?.priority ?? 'NORMAL');
  const [status, setStatus] = useState(record?.status ?? 'OPEN');
  const [dueAt, setDueAt] = useState(toLocalDateTime(record?.due_at ?? null));
  const requestId = useRef<string | null>(null);
  const debouncedSearch = useDebouncedValue(leadSearch, 300);
  const options = useQuery({
    queryKey: ['task-lead-options', debouncedSearch],
    queryFn: ({ signal }) => fetchTaskLeadOptions(debouncedSearch, signal),
    enabled: open && !record,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      if (record)
        return updateTask({
          taskId: record.id,
          expectedVersion: record.version,
          patch: {
            title,
            description: description || null,
            priority,
            status,
            due_at: new Date(dueAt).toISOString(),
          },
          requestId: requestId.current,
        });
      return createTask({
        leadId,
        title,
        description,
        priority,
        dueAt: new Date(dueAt).toISOString(),
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const resetRequest = () => {
    requestId.current = null;
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record ? 'Edit task' : 'Create task'}</DialogTitle>
          <DialogDescription>
            Tasks are linked to an authorized customer opportunity and remain inside your data
            scope.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label>Customer opportunity</Label>
            {record ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="font-medium">{record.customer_name ?? 'Linked opportunity'}</p>
                <p className="text-xs text-muted-foreground">
                  {record.interested_model ?? 'Vehicle not specified'} · {record.branch_name}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  value={leadSearch}
                  maxLength={160}
                  placeholder="Search customer, phone, model or lead ID"
                  onChange={(event) => setLeadSearch(event.target.value)}
                />
                <Select
                  value={leadId}
                  onValueChange={(value) => {
                    resetRequest();
                    setLeadId(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={options.isPending ? 'Loading…' : 'Select opportunity'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(options.data ?? []).map((option) => (
                      <SelectItem key={option.lead_id} value={option.lead_id}>
                        {option.customer_name} · {option.interested_model ?? 'Vehicle TBD'} ·{' '}
                        {option.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              maxLength={160}
              required
              onChange={(event) => {
                resetRequest();
                setTitle(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-description">Description (optional)</Label>
            <Textarea
              id="task-description"
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(event) => {
                resetRequest();
                setDescription(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(value) => {
                  resetRequest();
                  setPriority(value);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {record && (
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    resetRequest();
                    setStatus(value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPEN">Open</SelectItem>
                    <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-due">Due date and time</Label>
            <Input
              id="task-due"
              type="datetime-local"
              value={dueAt}
              required
              onChange={(event) => {
                resetRequest();
                setDueAt(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isTaskVersionConflict(mutation.error)
                  ? 'This task changed elsewhere. Close and reopen it before saving.'
                  : 'The task could not be saved. Check the due date and linked opportunity.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || (!record && !leadId) || !title.trim() || !dueAt}
            >
              {mutation.isPending ? 'Saving…' : record ? 'Save task' : 'Create task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskActionDialog({
  action,
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  action: 'complete' | 'cancel';
  record: TaskRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      const common = {
        taskId: record.id,
        expectedVersion: record.version,
        requestId: requestId.current,
      };
      return action === 'complete'
        ? completeTask({ ...common, note })
        : cancelTask({ ...common, reason: note });
    },
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === 'complete' ? 'Complete task' : 'Cancel task'}</DialogTitle>
          <DialogDescription>
            This action is version-checked and recorded in the customer and audit timelines.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="task-action-note">
              {action === 'complete' ? 'Completion note (optional)' : 'Cancellation reason'}
            </Label>
            <Textarea
              id="task-action-note"
              value={note}
              required={action === 'cancel'}
              minLength={action === 'cancel' ? 3 : undefined}
              maxLength={action === 'cancel' ? 500 : 2000}
              rows={3}
              onChange={(event) => {
                requestId.current = null;
                setNote(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isTaskVersionConflict(mutation.error)
                  ? 'This task changed elsewhere. Close and reopen the action.'
                  : 'The task action could not be completed.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Back
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || (action === 'cancel' && note.trim().length < 3)}
            >
              {mutation.isPending ? 'Saving…' : action === 'complete' ? 'Complete' : 'Cancel task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
