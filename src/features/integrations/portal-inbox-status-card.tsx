'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import {
  fetchPortalInboxActivity,
  fetchPortalInboxState,
  PORTAL_INBOX_ACTIVITY_PAGE_SIZE,
  requestPortalInboxSync,
  type PortalInboxMessage,
} from './portal-inbox-api';

const errorMessages: Record<string, string> = {
  IMAP_AUTH_FAILED:
    'The mailbox rejected the login. Check the email address and app password, then save again.',
  IMAP_UNREACHABLE: 'The mail server could not be reached. The next check will try again.',
  MAILBOX_SOURCE_DISCONNECTED:
    'The connection whose inbox this one shares was removed. Connect a mailbox here.',
  MAILBOX_CREDENTIAL_MISSING: 'No mailbox password is stored. Enter the app password again.',
  PORTAL_INBOX_RULES_MISSING: 'Sender address or keywords are missing. Edit the inbox settings.',
  NO_BRANCH_AVAILABLE: 'No active branch can receive these leads.',
  PORTAL_INBOX_TEST_NOT_QUEUED: 'The first inbox check could not be started. Use Test connection.',
  PORTAL_INBOX_SYNC_FAILED: 'The last inbox check failed. The next check will try again.',
};

const statusBadges: Record<PortalInboxMessage['status'], [string, BadgeVariant]> = {
  INGESTED: ['Lead created', 'success'],
  DUPLICATE: ['Already a lead', 'secondary'],
  PARSE_FAILED: ['Skipped', 'warning'],
  FAILED: ['Failed', 'destructive'],
};

function failureText(code: string | null) {
  if (!code) return null;
  if (code.startsWith('MISSING_'))
    return `No ${code
      .slice('MISSING_'.length)
      .toLowerCase()
      .replaceAll('_and_', ' or ')
      .replaceAll('customer_name', 'name')
      .replaceAll('phone', 'mobile')} found`;
  if (code === 'MESSAGE_TOO_LARGE') return 'Email too large';
  return code.replaceAll('_', ' ').toLowerCase();
}

function formatTime(value: string | null) {
  if (!value) return 'Not yet';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function PortalInboxStatusCard({
  organizationId,
  connectionId,
  canManage,
}: {
  organizationId: string;
  connectionId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const state = useQuery({
    queryKey: ['portal-inbox-state', organizationId, connectionId],
    queryFn: () => fetchPortalInboxState(connectionId),
  });
  const activity = useQuery({
    queryKey: ['portal-inbox-activity', organizationId, connectionId, page],
    queryFn: () => fetchPortalInboxActivity(connectionId, page),
    placeholderData: keepPreviousData,
  });
  const sync = useMutation({
    mutationFn: () => requestPortalInboxSync(organizationId, connectionId),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['portal-inbox-state', organizationId, connectionId],
      }),
  });
  const pageCount = Math.max(
    1,
    Math.ceil((activity.data?.total ?? 0) / PORTAL_INBOX_ACTIVITY_PAGE_SIZE),
  );
  const current = state.data;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">Inbox checks</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {current
              ? `Every ${current.poll_interval_minutes} minutes. Next check ${formatTime(current.next_poll_at)}.`
              : 'Schedule not set up yet.'}
          </p>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={sync.isPending || !current}
          >
            <RefreshCw className="size-4" />
            {sync.isPending ? 'Requesting…' : 'Sync now'}
          </Button>
        )}
      </div>
      {sync.isSuccess && (
        <p className="text-sm text-muted-foreground">The inbox is checked within a minute.</p>
      )}
      {sync.isError && (
        <Alert variant="destructive">
          <AlertDescription>{sync.error.message}</AlertDescription>
        </Alert>
      )}
      {state.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : state.isError ? (
        <Alert variant="destructive">
          <AlertDescription>The inbox schedule could not be loaded.</AlertDescription>
        </Alert>
      ) : current ? (
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Last checked</dt>
            <dd className="font-medium">{formatTime(current.last_success_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Portal emails read</dt>
            <dd className="font-medium">{current.messages_seen}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Leads created</dt>
            <dd className="font-medium">{current.leads_created}</dd>
          </div>
        </dl>
      ) : null}
      {current?.last_error_code && (
        <Alert variant="destructive">
          <AlertDescription>
            {errorMessages[current.last_error_code] ?? 'The last inbox check failed.'}
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Recent portal emails</h4>
        {activity.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : activity.isError ? (
          <Alert variant="destructive">
            <AlertDescription>Recent emails could not be loaded.</AlertDescription>
          </Alert>
        ) : !activity.data.rows.length ? (
          <p className="text-sm text-muted-foreground">No portal emails read yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableBody>
                  {activity.data.rows.map((row) => {
                    const [label, variant] = statusBadges[row.status];
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="max-w-56">
                          <p className="truncate text-sm font-medium">
                            {row.subject || '(no subject)'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatTime(row.received_at ?? row.created_at)}
                            {failureText(row.failure_code) && ` · ${failureText(row.failure_code)}`}
                          </p>
                        </TableCell>
                        <TableCell className="w-32 text-right">
                          <Badge variant={variant}>{label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                Page {page} of {pageCount}
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Next page"
                  disabled={page >= pageCount}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
