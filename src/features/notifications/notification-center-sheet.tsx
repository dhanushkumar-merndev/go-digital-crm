'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Search,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { RoleKey } from '@/config/navigation/types';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { headerNotificationsKey, markHeaderNotificationRead } from './notification-api';
import {
  fetchNotificationPage,
  notificationWorkspaceKey,
  type NotificationStatusFilter,
} from './notification-workspace-api';

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }).format(date);
}

export function NotificationCenterSheet({
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
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<NotificationStatusFilter>('all');
  const [page, setPage] = useState(1);
  const search = useDebouncedValue(searchInput, 300);

  useEffect(() => setPage(1), [search, status]);
  useEffect(() => {
    if (open) return;
    setSearchInput('');
    setStatus('all');
    setPage(1);
  }, [open]);

  const queryKey = useMemo(
    () => [
      ...notificationWorkspaceKey,
      ...workspaceQueryScope(workspaceSession),
      'header-center',
      search,
      status,
      page,
    ],
    [workspaceSession, search, status, page],
  );
  const notifications = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchNotificationPage({ page, pageSize: 25, search, status, signal }),
    enabled: open && Boolean(workspaceSession?.userId),
    staleTime: 60_000,
  });
  const markRead = useMutation({
    mutationFn: markHeaderNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationWorkspaceKey });
      void queryClient.invalidateQueries({ queryKey: headerNotificationsKey });
    },
    onError: () => {
      toast.add({
        title: 'Could not update notification',
        description: 'Please try again in a moment.',
        type: 'error',
      });
    },
  });

  const openRelatedCustomer = (resourceType: string | null, resourceId: string | null) => {
    if (resourceType !== 'customer' || !resourceId) return;
    onOpenChange(false);
    router.push(`/${role}/customers/${resourceId}`);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-xl flex-col p-0 sm:w-[540px]">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <BellRing className="size-4 text-blue-600" /> Notification center
          </SheetTitle>
          <SheetDescription>Your private, server-paginated notification history.</SheetDescription>
        </SheetHeader>
        <div className="flex gap-2 border-b p-4">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="h-9 pl-9 text-xs"
              placeholder="Search notifications"
              aria-label="Search notifications"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as NotificationStatusFilter)}
          >
            <SelectTrigger className="h-9 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="unread">Unread</SelectItem>
              <SelectItem value="read">Read</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {notifications.isPending ? (
            <div className="space-y-2 p-2" aria-label="Loading notification center">
              <div className="h-20 animate-pulse rounded-md bg-slate-100" />
              <div className="h-20 animate-pulse rounded-md bg-slate-100" />
            </div>
          ) : notifications.isError ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Notifications could not be loaded. Try again in a moment.
            </p>
          ) : notifications.data?.records.length ? (
            notifications.data.records.map((record) => (
              <article
                key={record.id}
                className={`rounded-lg px-3 py-3 ${record.read_at ? '' : 'bg-blue-50/70'}`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${record.read_at ? 'bg-slate-300' : 'bg-blue-500'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold text-[#17233d]">{record.title}</p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatDate(record.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{record.body}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!record.read_at ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={markRead.isPending}
                          onClick={() => markRead.mutate(record.id)}
                        >
                          <CheckCheck className="size-3.5" /> Mark read
                        </Button>
                      ) : null}
                      {record.resource_type === 'customer' && record.resource_id ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-blue-700 hover:text-blue-800"
                          onClick={() =>
                            openRelatedCustomer(record.resource_type, record.resource_id)
                          }
                        >
                          Open customer
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="flex flex-col items-center p-10 text-center">
              <CheckCheck className="size-7 text-blue-600" />
              <p className="mt-3 text-sm font-semibold text-[#17233d]">All caught up</p>
              <p className="mt-1 text-xs text-muted-foreground">
                No notifications match these server-side filters.
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t p-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1 || notifications.isFetching}
            onClick={() => setPage((current) => current - 1)}
          >
            <ChevronLeft className="size-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {notifications.isFetching ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              `Page ${page}`
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!notifications.data?.hasNext || notifications.isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
