'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, ClipboardList, LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { RoleKey } from '@/config/navigation/types';
import {
  completeTask,
  fetchTaskPermissions,
  fetchTaskWorkspace,
  type TaskPermissions,
  type TaskRecord,
} from './task-workspace-api';
import type { TaskQuery, TaskStatusFilter } from './task-workspace-query';

const statusTabs: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
];

function formatDueDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

function priorityVariant(priority: string): 'destructive' | 'secondary' | 'outline' {
  if (priority === 'URGENT') return 'destructive';
  if (priority === 'HIGH') return 'secondary';
  return 'outline';
}

export function TaskCenterSheet({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleKey;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<TaskStatusFilter>('today');
  const [page, setPage] = useState(1);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    [],
  );
  const query: TaskQuery = useMemo(
    () => ({
      page,
      pageSize: 25,
      search: '',
      status,
      priority: 'all',
      sort: 'due:asc',
    }),
    [page, status],
  );
  const bootstrapPermissions: TaskPermissions | undefined = workspaceSession?.organizationId
    ? {
        organizationId: workspaceSession.organizationId,
        scopeKey: workspaceSession.scopeKey,
        canCreate: hasWorkspacePermission(workspaceSession, 'task.create'),
        canUpdate: hasWorkspacePermission(workspaceSession, 'task.update'),
        canComplete: hasWorkspacePermission(workspaceSession, 'task.complete'),
        canCancel: hasWorkspacePermission(workspaceSession, 'task.cancel'),
      }
    : undefined;
  const legacyPermissions = useQuery({
    queryKey: ['task-center-permissions', role],
    queryFn: fetchTaskPermissions,
    enabled: open && !bootstrapPermissions,
    staleTime: 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;
  const taskPage = useQuery({
    queryKey: ['task-center', ...workspaceQueryScope(workspaceSession), query, timezone],
    queryFn: ({ signal }) => fetchTaskWorkspace(query, timezone, signal),
    enabled: open && Boolean(permissions),
    staleTime: 60_000,
  });
  const complete = useMutation({
    mutationFn: (record: TaskRecord) =>
      completeTask({
        taskId: record.id,
        expectedVersion: record.version,
        note: '',
        requestId: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast.add({
        title: 'Task completed',
        description: 'The task was marked complete.',
        type: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['task-center'] });
      void queryClient.invalidateQueries({ queryKey: ['task-workspace'] });
    },
    onError: () => {
      toast.add({
        title: 'Could not complete task',
        description: 'The task may have changed. Refresh and try again.',
        type: 'error',
      });
    },
  });

  const changeStatus = (next: TaskStatusFilter) => {
    setStatus(next);
    setPage(1);
  };
  const openCustomer = (customerId: string | null) => {
    if (!customerId) return;
    onOpenChange(false);
    router.push(`/${role}/customers/${customerId}`);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-xl flex-col p-0 sm:w-[540px]">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <ClipboardList className="size-4 text-blue-600" /> Task center
          </SheetTitle>
          <SheetDescription>Lead-linked work in your authorized data scope.</SheetDescription>
        </SheetHeader>
        <div className="flex gap-1 overflow-x-auto border-b px-3 pt-2">
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium ${status === tab.value ? 'border-blue-600 text-blue-700' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              onClick={() => changeStatus(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {taskPage.isPending || legacyPermissions.isPending ? (
            <div className="space-y-2 p-2" aria-label="Loading tasks">
              <div className="h-24 animate-pulse rounded-md bg-slate-100" />
              <div className="h-24 animate-pulse rounded-md bg-slate-100" />
            </div>
          ) : taskPage.isError || legacyPermissions.isError || !permissions ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Tasks are unavailable for this account right now.
            </p>
          ) : taskPage.data?.records.length ? (
            taskPage.data.records.map((record) => (
              <article key={record.id} className="rounded-lg border-b px-3 py-3 last:border-b-0">
                <div className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold text-[#17233d]">{record.title}</p>
                      <Badge variant={priorityVariant(record.priority)}>{record.priority}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {record.customer_name ?? 'Unlinked customer'} · Due{' '}
                      {formatDueDate(record.due_at)}
                    </p>
                    {record.description ? (
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {record.description}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {record.customer_id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-blue-700 hover:text-blue-800"
                          onClick={() => openCustomer(record.customer_id)}
                        >
                          Open customer
                        </Button>
                      ) : null}
                      {permissions.canComplete &&
                      ['OPEN', 'IN_PROGRESS'].includes(record.status) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={complete.isPending}
                          onClick={() => complete.mutate(record)}
                        >
                          {complete.isPending ? (
                            <LoaderCircle className="size-3.5 animate-spin" />
                          ) : (
                            <Check className="size-3.5" />
                          )}
                          Mark complete
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="flex flex-col items-center p-10 text-center">
              <Check className="size-7 text-blue-600" />
              <p className="mt-3 text-sm font-semibold text-[#17233d]">No {status} tasks</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your server-side task queue is clear for this filter.
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t p-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1 || taskPage.isFetching}
            onClick={() => setPage((current) => current - 1)}
          >
            <ChevronLeft className="size-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {taskPage.isFetching ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              `Page ${page}`
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !taskPage.data || page * query.pageSize >= taskPage.data.total || taskPage.isFetching
            }
            onClick={() => setPage((current) => current + 1)}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
