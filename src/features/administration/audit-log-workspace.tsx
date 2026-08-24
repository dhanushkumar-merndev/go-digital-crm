'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, History, Search } from 'lucide-react';
import { AuditLogWorkspaceSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { fetchAuditLogPage, type AuditLogCursor, type AuditLogRecord } from './audit-log-api';

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

function identifier(value: string | null) {
  return value ? `${value.slice(0, 8)}…` : 'System';
}

function auditSummary(record: AuditLogRecord) {
  const message = record.metadata.safe_message ?? record.metadata.summary ?? record.metadata.reason;
  return typeof message === 'string' && message.trim()
    ? message.slice(0, 160)
    : 'No detail recorded';
}

export function AuditLogWorkspace({ spec }: { spec: PageSpec }) {
  const [actionInput, setActionInput] = useState('');
  const [resourceInput, setResourceInput] = useState('');
  const action = useDebouncedValue(actionInput, 300);
  const resource = useDebouncedValue(resourceInput, 300);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Array<AuditLogCursor | null>>([null]);
  const [prevFilter, setPrevFilter] = useState({ action, resource });
  if (prevFilter.action !== action || prevFilter.resource !== resource) {
    setPrevFilter({ action, resource });
    setPage(1);
    setCursors([null]);
  }
  const cursor = cursors[page - 1] ?? null;
  const query = useQuery({
    queryKey: ['audit-log-page', action, resource, cursor?.created_at ?? null, cursor?.id ?? null],
    queryFn: ({ signal }) => fetchAuditLogPage({ action, resource, cursor, signal }),
    staleTime: 60_000,
  });
  const nextPage = () => {
    const last = query.data?.records.at(-1);
    if (!last) return;
    setCursors((current) => {
      const next = [...current];
      next[page] = { created_at: last.created_at, id: last.id };
      return next;
    });
    setPage((current) => current + 1);
  };

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Administration › Security</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Immutable security and business-event records in your authorized scope.
        </p>
      </div>
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={actionInput}
              onChange={(event) => setActionInput(event.target.value)}
              className="pl-9"
              placeholder="Filter action, for example followup.created"
              aria-label="Filter audit log actions"
            />
          </div>
          <Input
            value={resourceInput}
            onChange={(event) => setResourceInput(event.target.value)}
            className="md:max-w-64"
            placeholder="Filter resource type"
            aria-label="Filter audit log resources"
          />
        </CardContent>
      </Card>
      {query.isPending ? <AuditLogWorkspaceSkeleton /> : null}
      {query.isError ? (
        <Card className="shadow-none">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Audit records could not be loaded for your current permission and branch scope.
          </CardContent>
        </Card>
      ) : null}
      {query.data ? (
        <>
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center gap-3 space-y-0 border-b">
              <span className="grid size-9 place-items-center rounded-lg bg-blue-50 text-blue-600">
                <History className="size-4" />
              </span>
              <div>
                <CardTitle className="text-base">Audit activity</CardTitle>
                <CardDescription>Newest first · 25 records per server page</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(record.created_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{record.action}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {record.resource_type}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {identifier(record.resource_id)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {identifier(record.actor_id)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {identifier(record.branch_id)}
                      </TableCell>
                      <TableCell
                        className="max-w-80 truncate text-xs text-muted-foreground"
                        title={auditSummary(record)}
                      >
                        {auditSummary(record)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!query.data.records.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No audit records match these server-side filters.
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
            <p className="text-xs text-muted-foreground">Page {page} · cursor pagination</p>
            <Button
              variant="outline"
              size="sm"
              disabled={!query.data.hasNext || query.isFetching}
              onClick={nextPage}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
