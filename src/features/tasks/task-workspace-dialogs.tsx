'use client';

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  Calendar,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  Clock,
  Sparkles,
} from 'lucide-react';
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
  DialogFooter,
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
import { flattenOptionPages, optionPagesQueryOptions } from '@/lib/query/option-query';
import { cn } from '@/lib/utils';
import {
  cancelTask,
  completeTask,
  createTask,
  fetchTaskLeadOptions,
  updateTask,
  type TaskRecord,
} from './task-workspace-api';
import { isTaskVersionConflict } from './task-workspace-query';

function toLocalInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toLocalDateTime(value: string | null) {
  return value ? toLocalInput(new Date(value)) : '';
}

const priorityChoices = [
  { value: 'LOW', label: 'Low', selected: 'border-slate-400 bg-slate-100 text-slate-800' },
  { value: 'NORMAL', label: 'Normal', selected: 'border-primary bg-primary/10 text-primary' },
  { value: 'HIGH', label: 'High', selected: 'border-amber-500 bg-amber-50 text-amber-800' },
  { value: 'URGENT', label: 'Urgent', selected: 'border-rose-500 bg-rose-50 text-rose-700' },
] as const;

/** The jobs a consultant or telecaller sets most; one tap instead of typing. */
const titleSuggestions = [
  'Call customer',
  'Collect documents',
  'Prepare test drive',
  'Follow up on quotation',
  'Confirm stock',
  'Update customer',
];

function atTen(date: Date, daysAhead: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(10, 0, 0, 0);
  return next;
}

/** Resolved when clicked, so "now" is read in the handler and not while rendering. */
const duePresets = [
  {
    id: 'hour',
    label: 'In 1 hour',
    icon: Clock,
    resolve: (now: Date) => {
      // Rounded up to five minutes: 3:07 pm becomes 4:10 pm, not 4:07 pm.
      const next = new Date(now.getTime() + 60 * 60_000);
      next.setMinutes(Math.ceil(next.getMinutes() / 5) * 5, 0, 0);
      return next;
    },
  },
  {
    id: 'tomorrow',
    label: 'Tomorrow 10 am',
    icon: CalendarCheck2,
    resolve: (now: Date) => atTen(now, 1),
  },
  { id: 'three-days', label: 'In 3 days', icon: Calendar, resolve: (now: Date) => atTen(now, 3) },
  { id: 'week', label: 'Next week', icon: CalendarDays, resolve: (now: Date) => atTen(now, 7) },
];

const dueSummaryFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

type TaskFormErrors = { lead?: string; title?: string; due?: string };

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
  const [dueAt, setDueAt] = useState(
    record?.due_at ? toLocalDateTime(record.due_at) : toLocalInput(atTen(new Date(), 1)),
  );
  const [duePreset, setDuePreset] = useState<string | null>(record ? null : 'tomorrow');
  const [errors, setErrors] = useState<TaskFormErrors>({});
  const requestId = useRef<string | null>(null);
  const debouncedSearch = useDebouncedValue(leadSearch, 300);
  const options = useInfiniteQuery(
    optionPagesQueryOptions({
      queryKey: ['task-lead-options', ...queryScope, 'pages', debouncedSearch],
      fetchRows: (offset, limit, signal) =>
        fetchTaskLeadOptions(debouncedSearch, signal, { offset, limit }),
      // A lead-row task shortcut supplies the exact lead. Do not load the
      // general picker or let the user accidentally switch that customer.
      enabled: open && !record && !initialLead,
    }),
  );
  const leadOptions = flattenOptionPages(options.data) ?? [];
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
  /** An edit to one field clears that field's message and any stale save error. */
  const edited = (field: keyof TaskFormErrors | null) => {
    resetRequest();
    if (field) setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const submit = () => {
    if (mutation.isPending) return;
    const next: TaskFormErrors = {};
    if (!record && !leadId) next.lead = 'Choose the customer this task is for.';
    if (!title.trim()) next.title = 'Say what needs to be done.';
    const dueTime = dueAt ? new Date(dueAt).getTime() : Number.NaN;
    if (Number.isNaN(dueTime)) next.due = 'Choose when this is due.';
    else if (!record && dueTime <= Date.now()) {
      next.due = 'Choose a time that has not passed yet.';
      toast.add({
        type: 'error',
        priority: 'high',
        title: 'Choose a future due date',
        description: 'A new task cannot be scheduled in the past.',
      });
    }
    setErrors(next);
    // The button stays enabled so a missing field is explained, not just blocked.
    const firstInvalid = next.lead
      ? 'task-lead-search'
      : next.title
        ? 'task-title'
        : next.due
          ? 'task-due'
          : null;
    if (firstInvalid) {
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    mutation.mutate();
  };
  const dueDate = dueAt ? new Date(dueAt) : null;
  const dueSummary =
    dueDate && !Number.isNaN(dueDate.getTime()) ? dueSummaryFormat.format(dueDate) : null;
  const datePart = dueAt ? dueAt.slice(0, 10) : '';
  const timePart = dueAt ? dueAt.slice(11, 16) : '';

  const handleDateChange = (newDate: string) => {
    edited('due');
    setDuePreset(null);
    if (!newDate) {
      setDueAt('');
      return;
    }
    const time = timePart || '10:00';
    setDueAt(`${newDate}T${time}`);
  };

  const handleTimeChange = (newTime: string) => {
    edited('due');
    setDuePreset(null);
    if (!newTime) return;
    const date = datePart || toLocalInput(new Date()).slice(0, 10);
    setDueAt(`${date}T${newTime}`);
  };

  // Suggestions step aside once the user has typed a title of their own.
  const showTitleSuggestions = !record && (!title.trim() || titleSuggestions.includes(title));
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
            {record
              ? 'Change what needs doing, how urgent it is or when it is due.'
              : 'Note what needs doing for this customer and when it is due.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            // Ctrl/⌘ + Enter saves from anywhere, including the notes box.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={record || initialLead ? undefined : 'task-lead-search'}>Customer</Label>
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
                  hasMore={options.hasNextPage}
                  onLoadMore={() => void options.fetchNextPage()}
                  isLoadingMore={options.isFetchingNextPage}
                  isError={options.isError}
                  placeholder="Choose a customer"
                  searchPlaceholder="Search customer, phone, model or lead ID"
                  emptyMessage="No opportunity you can task matches this search."
                  errorMessage="Customer opportunities could not be loaded."
                  aria-label="Select customer opportunity"
                  onValueChange={(value) => {
                    edited('lead');
                    setLeadId(value);
                  }}
                />
                {errors.lead ? (
                  <p role="alert" className="text-xs text-destructive">
                    {errors.lead}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {options.isFetching && !options.isFetchingNextPage
                      ? 'Searching…'
                      : options.hasNextPage
                        ? `Showing ${leadOptions.length} matches — keep typing to narrow or see more`
                        : `${leadOptions.length} match${leadOptions.length === 1 ? '' : 'es'}`}
                  </p>
                )}
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
                ) : !options.isPending && leadOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No authorized active opportunities match this search.
                  </p>
                ) : null}
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-title">What needs to be done?</Label>
            <Input
              id="task-title"
              value={title}
              maxLength={160}
              required
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? 'task-title-error' : undefined}
              placeholder="e.g. Call to confirm the test drive"
              onChange={(event) => {
                edited('title');
                setTitle(event.target.value);
              }}
            />
            {errors.title && (
              <p id="task-title-error" role="alert" className="text-xs text-destructive">
                {errors.title}
              </p>
            )}
            {showTitleSuggestions && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Sparkles className="size-3 text-amber-500" />
                  <span>Quick task templates:</span>
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common tasks">
                  {titleSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      aria-pressed={title === suggestion}
                      className={cn(
                        'h-7 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        title === suggestion
                          ? 'border-primary bg-primary/10 font-semibold text-primary'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                      onClick={() => {
                        edited('title');
                        setTitle(suggestion);
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="grid gap-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="task-due" className="text-xs font-semibold">
                When is it due?
              </Label>
              {dueSummary ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700">
                  <CalendarClock className="size-3 text-blue-600" />
                  {dueSummary}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick due times">
              {duePresets.map((preset) => {
                const Icon = preset.icon;
                const isSelected = duePreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={isSelected}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected
                        ? 'border-blue-600 bg-blue-50/80 font-semibold text-blue-700 shadow-xs'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900',
                    )}
                    onClick={() => {
                      edited('due');
                      setDuePreset(preset.id);
                      setDueAt(toLocalInput(preset.resolve(new Date())));
                    }}
                  >
                    <Icon
                      className={cn('size-3.5', isSelected ? 'text-blue-600' : 'text-slate-400')}
                    />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-slate-500">Date</span>
                <div className="relative">
                  <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="task-due"
                    type="date"
                    value={datePart}
                    min={record ? undefined : toLocalInput(new Date()).slice(0, 10)}
                    required
                    aria-invalid={Boolean(errors.due)}
                    aria-describedby="task-due-help"
                    className={cn(
                      'h-9 bg-white pl-9 text-xs font-medium',
                      errors.due && 'border-destructive focus-visible:ring-destructive',
                    )}
                    onChange={(event) => handleDateChange(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-medium text-slate-500">Time</span>
                <div className="relative">
                  <Clock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    id="task-due-time"
                    type="time"
                    value={timePart}
                    required
                    className="h-9 bg-white pl-9 text-xs font-medium"
                    onChange={(event) => handleTimeChange(event.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] text-muted-foreground">Quick times:</span>
              {[
                { label: '10:00 am', time: '10:00' },
                { label: '12:00 pm', time: '12:00' },
                { label: '02:00 pm', time: '14:00' },
                { label: '05:00 pm', time: '17:00' },
                { label: '06:30 pm', time: '18:30' },
              ].map((t) => (
                <button
                  key={t.time}
                  type="button"
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                    timePart === t.time
                      ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                  )}
                  onClick={() => handleTimeChange(t.time)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <p
              id="task-due-help"
              role={errors.due ? 'alert' : undefined}
              className={cn(
                'text-xs',
                errors.due ? 'font-medium text-destructive' : 'text-muted-foreground',
              )}
            >
              {errors.due ??
                (dueSummary ? `Due ${dueSummary}` : 'Pick a quick time or set your own.')}
            </p>
          </div>
          <div className="grid gap-2">
            <Label id="task-priority-label">Priority</Label>
            <div
              className="grid grid-cols-4 gap-1.5"
              role="group"
              aria-labelledby="task-priority-label"
            >
              {priorityChoices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={priority === choice.value}
                  className={cn(
                    'h-9 rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    priority === choice.value
                      ? choice.selected
                      : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                  onClick={() => {
                    edited(null);
                    setPriority(choice.value);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          {record && (
            <div className="grid gap-2 sm:max-w-[50%]">
              <Label htmlFor="task-status">Status</Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  edited(null);
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
          <div className="grid gap-2">
            <Label htmlFor="task-description">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="task-description"
              value={description}
              maxLength={2000}
              rows={2}
              placeholder="Anything worth remembering when you pick this up"
              onChange={(event) => {
                edited(null);
                setDescription(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isTaskVersionConflict(mutation.error)
                  ? 'Someone else changed this task. Close and reopen it to see the latest, then try again.'
                  : 'The task could not be saved. Check the details and try again.'}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : record ? 'Save task' : 'Create task'}
            </Button>
          </DialogFooter>
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
          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
