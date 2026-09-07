'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { notificationDetailHref } from '@/lib/navigation/record-links';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCheck, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { NotificationWorkspaceSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useWorkspaceSession } from '@/components/providers/workspace-session-provider';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { markHeaderNotificationRead, headerNotificationsKey } from './notification-api';
import {
  fetchNotificationPage,
  notificationPageSizes,
  notificationWorkspaceKey,
  type NotificationPageSize,
  type NotificationStatusFilter,
} from './notification-workspace-api';

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }).format(date);
}

function eventLabel(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function NotificationWorkspace({ spec }: { spec: PageSpec }) {
  const workspaceSession = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<NotificationStatusFilter>('all');
  const [pageSize, setPageSize] = useState<NotificationPageSize>(25);
  const [page, setPage] = useState(1);
  const search = useDebouncedValue(searchInput, 300);
  const [prevFilter, setPrevFilter] = useState({ search, status, pageSize });
  if (
    prevFilter.search !== search ||
    prevFilter.status !== status ||
    prevFilter.pageSize !== pageSize
  ) {
    setPrevFilter({ search, status, pageSize });
    setPage(1);
  }

  const queryKey = useMemo(
    () => [
      ...notificationWorkspaceKey,
      workspaceSession?.organizationId ?? 'no-organization',
      workspaceSession?.userId ?? 'no-user',
      search,
      status,
      page,
      pageSize,
    ],
    [workspaceSession?.organizationId, workspaceSession?.userId, search, status, page, pageSize],
  );
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchNotificationPage({ page, pageSize, search, status, signal }),
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
  const unreadOnPage = query.data?.records.filter((record) => !record.read_at).length ?? 0;

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Administration › Alerts</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review updates addressed to your authenticated account. Read state is private to you.
        </p>
      </div>

      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="pl-9"
              placeholder="Search your notification title or message"
              aria-label="Search notifications"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as NotificationStatusFilter)}
          >
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All notifications</SelectItem>
              <SelectItem value="unread">Unread only</SelectItem>
              <SelectItem value="read">Read only</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => setPageSize(Number(value) as NotificationPageSize)}
          >
            <SelectTrigger className="w-full lg:w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {notificationPageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {query.isPending ? <NotificationWorkspaceSkeleton /> : null}
      {query.isError ? (
        <Card className="shadow-none">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Notifications could not be loaded for your current account. Try again in a moment.
          </CardContent>
        </Card>
      ) : null}
      {query.data ? (
        <>
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center gap-3 space-y-0 border-b">
              <span className="grid size-9 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <BellRing className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">Your notification history</CardTitle>
                <CardDescription>
                  Newest first ·{' '}
                  {unreadOnPage
                    ? `${unreadOnPage} unread on this page`
                    : 'No unread items on this page'}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Notification</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.records.map((record) => (
                    <TableRow
                      key={record.id}
                      className={record.read_at ? undefined : 'bg-blue-50/30'}
                    >
                      <TableCell>
                        <Badge variant={record.read_at ? 'outline' : 'default'}>
                          {record.read_at ? 'Read' : 'Unread'}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-80">
                        {workspaceSession &&
                        notificationDetailHref(
                          workspaceSession.roleKey,
                          record.resource_type,
                          record.resource_id,
                        ) ? (
                          <Link
                            className="font-medium text-primary hover:underline"
                            href={notificationDetailHref(
                              workspaceSession.roleKey,
                              record.resource_type,
                              record.resource_id,
                            )!}
                          >
                            {record.title}
                          </Link>
                        ) : (
                          <p className="font-medium text-[#17233d]">{record.title}</p>
                        )}
                        <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
                          {record.body}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {eventLabel(record.event_type)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(record.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {!record.read_at ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markRead.isPending}
                            onClick={() => markRead.mutate(record.id)}
                          >
                            <CheckCheck className="size-3.5" /> Mark read
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {formatDate(record.read_at)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!query.data.records.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-12 text-center text-sm text-muted-foreground"
                      >
                        No notifications match these server-side filters.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || query.isFetching}
              onClick={() => setPage((current) => current - 1)}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <p className="text-xs text-muted-foreground">Page {page} · server-side pagination</p>
            <Button
              variant="outline"
              size="sm"
              disabled={!query.data.hasNext || query.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
