'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
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
import { SearchSelect } from '@/components/ui/search-select';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { optionQueryOptions } from '@/lib/query/option-query';
import {
  cancelTask,
  completeTask,
  createTask,
  fetchTaskLeadOptions,
  TASK_LEAD_OPTION_LIMIT,
  updateTask,
  type TaskRecord,
} from './task-workspace-api';

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function TaskFormDialog({
  record,
  initialLead,
  open,
  onOpenChange,
  onSaved,
}: {
  record?: TaskRecord | null;
  initialLead?: {
    leadId: string;
    customerName: string;
    phone: string | null;
    interestedModel: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [leadId, setLeadId] = useState(record?.lead_id ?? initialLead?.leadId ?? '');
  const [leadSearch, setLeadSearch] = useState('');
  const [title, setTitle] = useState(record?.title ?? '');
  const [description, setDescription] = useState(record?.description ?? '');
  const [priority, setPriority] = useState(record?.priority ?? 'NORMAL');
  const [status, setStatus] = useState(record?.status ?? 'OPEN');
  const [dueAt, setDueAt] = useState(toLocalDateTime(record?.due_at ?? null));
  const requestId = useRef<string | null>(null);
  const debouncedSearch = useDebouncedValue(leadSearch, 300);
  const options = useQuery(
    optionQueryOptions({
      queryKey: ['task-lead-options', ...queryScope, debouncedSearch],
      queryFn: ({ signal }) => fetchTaskLeadOptions(debouncedSearch, signal),
      // A lead-row task shortcut supplies the exact lead. Do not load the
      // general picker or let the user accidentally switch that customer.
      enabled: open && !record && !initialLead,
    }),
  );
  const leadOptions = options.data ?? [];
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
    mutation.reset();
  };
  const submit = () => {
    if (!record && new Date(dueAt).getTime() <= Date.now()) {
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Choose a future due date',
        description: 'A new task cannot be scheduled in the past.',
      });
      return;
    }
    mutation.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) onOpenChange(nextOpen);
      }}
    >
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
            submit();
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
            ) : initialLead ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="font-medium">{initialLead.customerName}</p>
                <p className="text-xs text-muted-foreground">
                  {[initialLead.phone, initialLead.interestedModel ?? 'Vehicle not specified']
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <SearchSelect
                  id="task-lead-search"
                  value={leadId}
                  search={leadSearch}
                  onSearchChange={setLeadSearch}
                  options={leadOptions.map((option) => ({
                    value: option.lead_id,
                    label: option.customer_name,
                    description: [option.interested_model ?? 'Vehicle TBD', option.branch_name]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                  isPending={options.isPending}
                  isFetching={options.isFetching}
                  isError={options.isError}
                  placeholder="Select opportunity"
                  searchPlaceholder="Search customer, phone, model or lead ID"
                  emptyMessage="No opportunity you can task matches this search."
                  errorMessage="Customer opportunities could not be loaded."
                  aria-label="Select customer opportunity"
                  onValueChange={(value) => {
                    resetRequest();
                    setLeadId(value);
                  }}
                />
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {options.isFetching
                    ? 'Searching…'
                    : leadOptions.length === TASK_LEAD_OPTION_LIMIT
                      ? `Showing first ${TASK_LEAD_OPTION_LIMIT} matches — keep typing to narrow`
                      : `${leadOptions.length} match${leadOptions.length === 1 ? '' : 'es'}`}
                </p>
                {options.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription className="flex items-center justify-between gap-3">
                      <span>Customer opportunities could not be loaded.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void options.refetch()}
                      >
                        Try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : !options.isPending && options.data?.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No authorized active opportunities match this search.
                  </p>
                ) : null}
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
              <Label htmlFor="task-priority">Priority</Label>
              <Select
                value={priority}
                onValueChange={(value) => {
                  resetRequest();
                  setPriority(value);
                }}
              >
                <SelectTrigger id="task-priority">
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
                <Label htmlFor="task-status">Status</Label>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    resetRequest();
                    setStatus(value);
                  }}
                >
                  <SelectTrigger id="task-status">
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
              min={record ? undefined : toLocalDateTime(new Date().toISOString())}
              required
              onChange={(event) => {
                resetRequest();
                setDueAt(event.target.value);
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
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
  const resetRequest = () => {
    requestId.current = null;
    mutation.reset();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) onOpenChange(nextOpen);
      }}
    >
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
                resetRequest();
                setNote(event.target.value);
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
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
