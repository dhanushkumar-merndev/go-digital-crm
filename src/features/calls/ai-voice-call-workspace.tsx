'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AudioLines,
  Bot,
  ChevronLeft,
  ChevronRight,
  FileAudio,
  MessageSquareText,
  PhoneCall,
  PhoneForwarded,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric } from '@/lib/domain';
import { fetchAiVoiceCallWorkspace } from './ai-voice-call-workspace-api';

const statusOptions = [
  ['ALL', 'All statuses'],
  ['PENDING', 'In progress'],
  ['COMPLETED', 'Completed'],
  ['FAILED', 'Failed'],
  ['CANCELLED', 'Cancelled'],
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function initialQuery(params: URLSearchParams) {
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  const rawStatus = params.get('status')?.toUpperCase() ?? 'ALL';
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: ([25, 50, 100].includes(pageSize) ? pageSize : 25) as 25 | 50 | 100,
    search: (params.get('q') ?? '').slice(0, 160),
    status: statusOptions.some(([value]) => value === rawStatus) ? rawStatus : 'ALL',
  };
}

export function AiVoiceCallWorkspace() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(() => initialQuery(searchParams));
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const request = { ...query, search: debouncedSearch };
  const dataQuery = useQuery({
    queryKey: ['ai-voice-call-workspace', request],
    queryFn: ({ signal }) => fetchAiVoiceCallWorkspace(request, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const update = (next: Partial<typeof query>) => {
    const value = { ...query, ...next };
    setQuery(value);
    const params = new URLSearchParams();
    if (value.page > 1) params.set('page', String(value.page));
    if (value.pageSize !== 25) params.set('pageSize', String(value.pageSize));
    if (value.search) params.set('q', value.search);
    if (value.status !== 'ALL') params.set('status', value.status);
    router.replace(`${pathname}${params.size ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  const metrics = useMemo<Metric[]>(() => {
    const kpis = dataQuery.data?.kpis;
    return [
      {
        label: 'AI calls initiated',
        value: (kpis?.initiated_today ?? 0).toLocaleString(),
        icon: PhoneCall,
      },
      {
        label: 'Calls connected',
        value: (kpis?.connected_today ?? 0).toLocaleString(),
        icon: PhoneForwarded,
      },
      { label: 'Callbacks open', value: (kpis?.callbacks_open ?? 0).toLocaleString(), icon: Bot },
      {
        label: 'Recordings ready',
        value: (kpis?.recordings_ready_today ?? 0).toLocaleString(),
        icon: FileAudio,
      },
    ];
  }, [dataQuery.data?.kpis]);

  if (dataQuery.isPending) return <PageSkeleton />;
  if (dataQuery.isError || !dataQuery.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          AI voice activity is unavailable. Confirm your call-view permission and deploy the AI
          voice workspace migration.
        </CardContent>
      </Card>
    );

  const result = dataQuery.data;
  const pageCount = Math.max(1, Math.ceil(result.total / query.pageSize));
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Calls › AI voice</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">
            AI Voice Call Activity
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Verified AI-provider calls only, within your assigned CRM data scope.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/sales-consultant/calls">
            <PhoneCall className="size-4" /> Open calls
          </Link>
        </Button>
      </div>

      {!result.has_verified_provider ? (
        <Alert className="border-blue-200 bg-blue-50/60 text-blue-950">
          <Bot className="size-4 text-blue-600" />
          <AlertTitle>No verified AI voice provider is connected</AlertTitle>
          <AlertDescription>
            A Client Admin must connect and verify an AI voice provider before this page can display
            provider call activity. Credentials remain server-side.
          </AlertDescription>
        </Alert>
      ) : null}

      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="gap-4 border-b py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">AI voice calls</CardTitle>
            <CardDescription>Recorded calls are paginated on the server.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-56">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => update({ search: event.target.value, page: 1 })}
                className="pl-9"
                placeholder="Customer, phone, provider..."
              />
            </div>
            <Select value={query.status} onValueChange={(status) => update({ status, page: 1 })}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>AI provider</TableHead>
                <TableHead>Call status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Assets</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.records.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <p className="font-medium">{record.customer_name ?? 'Restricted customer'}</p>
                    <p className="text-xs text-muted-foreground">
                      {record.phone ?? 'Phone restricted'}
                    </p>
                  </TableCell>
                  <TableCell className="font-medium">{record.provider_name}</TableCell>
                  <TableCell>
                    <StatusBadge value={record.status} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={record.outcome ?? 'PENDING'} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(record.started_at)}
                  </TableCell>
                  <TableCell>{formatDuration(record.duration_seconds)}</TableCell>
                  <TableCell>
                    <div className="flex gap-2 text-muted-foreground">
                      {record.recording_available ? (
                        <FileAudio
                          className="size-4 text-blue-600"
                          aria-label="Recording available"
                        />
                      ) : null}
                      {record.transcript_available ? (
                        <MessageSquareText
                          className="size-4 text-violet-600"
                          aria-label="Transcript available"
                        />
                      ) : null}
                      {!record.recording_available && !record.transcript_available ? '—' : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!result.records.length ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    <AudioLines className="mx-auto mb-3 size-6 text-muted-foreground/70" />
                    No AI voice calls match this scope.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-3 text-sm text-muted-foreground">
            <span>
              {result.total.toLocaleString()} call{result.total === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={String(query.pageSize)}
                onValueChange={(value) =>
                  update({ page: 1, pageSize: Number(value) as 25 | 50 | 100 })
                }
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[25, 50, 100].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={query.page <= 1}
                onClick={() => update({ page: query.page - 1 })}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span>
                {query.page} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={query.page >= pageCount}
                onClick={() => update({ page: query.page + 1 })}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
