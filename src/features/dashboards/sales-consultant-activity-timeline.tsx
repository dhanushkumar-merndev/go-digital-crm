'use client';

import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarCheck2,
  CalendarClock,
  CarFront,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  LoaderCircle,
  MessageCircle,
  NotebookPen,
  Phone,
  Search,
  Send,
  SquareCheckBig,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { cn } from '@/lib/utils';
import {
  fetchSalesConsultantActivityTimeline,
  salesActivityTimelineKey,
  type SalesActivityKind,
  type SalesActivityQuery,
  type SalesConsultantActivityTimeline,
} from './sales-consultant-activity-api';

const activityTabs: Array<{ value: SalesActivityQuery['kind']; label: string }> = [
  { value: 'ALL', label: 'All activities' },
  { value: 'CALL', label: 'Calls' },
  { value: 'MESSAGE', label: 'Messages' },
  { value: 'FOLLOW_UP', label: 'Follow-ups' },
  { value: 'TEST_DRIVE', label: 'Test drives' },
  { value: 'QUOTATION', label: 'Quotations' },
  { value: 'TASK', label: 'Tasks' },
  { value: 'NOTE', label: 'Notes' },
];

const kinds: Record<SalesActivityKind, { label: string; icon: typeof Phone; tone: string }> = {
  CALL: { label: 'Call logged', icon: Phone, tone: 'bg-emerald-50 text-emerald-600' },
  MESSAGE: { label: 'Message activity', icon: MessageCircle, tone: 'bg-green-50 text-green-600' },
  FOLLOW_UP: {
    label: 'Follow-up scheduled',
    icon: CalendarClock,
    tone: 'bg-violet-50 text-violet-600',
  },
  TEST_DRIVE: { label: 'Test-drive activity', icon: CarFront, tone: 'bg-blue-50 text-blue-600' },
  QUOTATION: { label: 'Quotation activity', icon: FileText, tone: 'bg-orange-50 text-orange-600' },
  TASK: { label: 'Task activity', icon: SquareCheckBig, tone: 'bg-indigo-50 text-indigo-600' },
  APPOINTMENT: {
    label: 'Appointment activity',
    icon: CalendarCheck2,
    tone: 'bg-rose-50 text-rose-600',
  },
  NOTE: { label: 'Note added', icon: NotebookPen, tone: 'bg-amber-50 text-amber-600' },
  OTHER: { label: 'CRM activity', icon: ClipboardList, tone: 'bg-slate-100 text-slate-600' },
};

function dateHeading(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function time(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

function summaryItems(data: SalesConsultantActivityTimeline) {
  return [
    ['Calls', data.summary.calls, Phone, 'bg-emerald-50 text-emerald-600'],
    ['Messages', data.summary.messages, MessageCircle, 'bg-green-50 text-green-600'],
    ['Follow-ups', data.summary.followups, CalendarClock, 'bg-violet-50 text-violet-600'],
    ['Test drives', data.summary.test_drives, CarFront, 'bg-blue-50 text-blue-600'],
    ['Quotations', data.summary.quotations, FileText, 'bg-orange-50 text-orange-600'],
    ['Notes', data.summary.notes, NotebookPen, 'bg-amber-50 text-amber-600'],
  ] as const;
}

function TimelineRecord({
  record,
}: {
  record: SalesConsultantActivityTimeline['records'][number];
}) {
  const definition = kinds[record.activity_kind];
  const Icon = definition.icon;
  return (
    <div className="relative grid grid-cols-[58px_34px_minmax(0,1fr)_auto] gap-3 py-3 first:pt-1">
      <p className="pt-2 text-right text-[11px] font-medium text-muted-foreground">
        {time(record.occurred_at)}
      </p>
      <span className="relative z-10 grid size-8 place-items-center rounded-full border-4 border-white bg-slate-50">
        <span className={cn('grid size-7 place-items-center rounded-full', definition.tone)}>
          <Icon className="size-3.5" />
        </span>
      </span>
      <div className="min-w-0 pt-1">
        <p className="text-xs font-semibold text-[#17233d]">{definition.label}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {record.detail ?? record.activity_type.replaceAll('_', ' ')}
        </p>
        <p className="mt-1 text-[10px] text-slate-500">
          {record.customer_name} · {record.lead_reference}
          {record.interested_model ? ` · ${record.interested_model}` : ''}
          {record.actor_name ? ` · ${record.actor_name}` : ''}
        </p>
      </div>
      <div className="flex items-start gap-0.5 pt-1">
        {record.customer_phone && (
          <>
            <Button asChild variant="ghost" size="icon" className="size-7 text-blue-600">
              <a href={`tel:${record.customer_phone}`} aria-label={`Call ${record.customer_name}`}>
                <Phone className="size-3.5" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="icon" className="size-7 text-emerald-600">
              <a
                href={toWhatsAppClickToChatUrl(record.customer_phone)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Message ${record.customer_name} on WhatsApp`}
              >
                <WhatsAppIcon className="size-3.5" />
              </a>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Timeline({ data }: { data: SalesConsultantActivityTimeline }) {
  const groups = useMemo(() => {
    const next = new Map<string, SalesConsultantActivityTimeline['records']>();
    for (const record of data.records) {
      const key = new Date(record.occurred_at).toDateString();
      next.set(key, [...(next.get(key) ?? []), record]);
    }
    return [...next.values()];
  }, [data.records]);
  if (!data.records.length)
    return (
      <div className="py-20 text-center">
        <ClipboardList className="mx-auto size-7 text-slate-300" />
        <p className="mt-3 text-sm font-semibold">No matching activity</p>
        <p className="mt-1 text-xs text-muted-foreground">
          New events from your assigned leads will appear here.
        </p>
      </div>
    );
  return (
    <div className="relative px-4 pb-3 pt-4 before:absolute before:bottom-5 before:left-[87px] before:top-11 before:w-px before:bg-slate-200 sm:px-5">
      {groups.map((records) => (
        <section key={records[0]?.id} className="mb-4 last:mb-0">
          <p className="mb-2 text-[11px] font-semibold text-[#263550]">
            {dateHeading(records[0]?.occurred_at ?? '')}
          </p>
          {records.map((record) => (
            <TimelineRecord key={record.id} record={record} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SideRail({ data }: { data: SalesConsultantActivityTimeline }) {
  return (
    <aside className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle className="text-sm">Activity summary</CardTitle>
          <CardDescription>Last 7 days</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
          {summaryItems(data).map(([label, value, Icon, tone]) => (
            <div key={label} className="flex items-center gap-2">
              <span className={cn('grid size-7 place-items-center rounded-md', tone)}>
                <Icon className="size-3.5" />
              </span>
              <span>
                <span className="block text-[10px] text-muted-foreground">{label}</span>
                <span className="block text-sm font-bold text-[#17233d]">{value}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <CardTitle className="text-sm">Upcoming follow-ups</CardTitle>
          <Link
            href="/sales-consultant/follow-ups"
            className="text-[11px] font-medium text-blue-600"
          >
            View all
          </Link>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {data.upcoming_followups.length ? (
            data.upcoming_followups.map((item) => (
              <Link
                key={item.id}
                href="/sales-consultant/follow-ups"
                className="flex items-start gap-2 rounded-md p-1 transition-colors hover:bg-slate-50"
              >
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-600">
                  <CalendarClock className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-[#17233d]">
                    {item.customer_name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {item.detail ?? 'Follow-up'}
                  </span>
                  <span className="block text-[10px] text-slate-500">{fullDate(item.due_at)}</span>
                </span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[9px]">
                  {item.priority}
                </Badge>
              </Link>
            ))
          ) : (
            <p className="py-5 text-center text-xs text-muted-foreground">
              No follow-ups are scheduled.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <CardTitle className="text-sm">Recent notes</CardTitle>
          <Link href="/sales-consultant/my-leads" className="text-[11px] font-medium text-blue-600">
            View leads
          </Link>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {data.recent_notes.length ? (
            data.recent_notes.map((note) => (
              <div key={note.id} className="flex gap-2">
                <NotebookPen className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <p className="line-clamp-2 text-[11px] leading-4 text-[#263550]">{note.body}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {note.customer_name} · {fullDate(note.created_at)}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <p className="py-5 text-center text-xs text-muted-foreground">No customer notes yet.</p>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}

export function SalesConsultantActivityTimeline() {
  const [query, setQuery] = useState<SalesActivityQuery>({
    search: '',
    kind: 'ALL',
    page: 1,
    pageSize: 25,
    sort: 'latest:desc',
  });
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const timeline = useQuery({
    queryKey: [...salesActivityTimelineKey, requestQuery],
    queryFn: ({ signal }) => fetchSalesConsultantActivityTimeline(requestQuery, signal),
    placeholderData: keepPreviousData,
  });
  useTenantRealtimeInvalidation(timeline.data?.organization_id, [
    {
      resource: 'leads',
      queryKeys: [salesActivityTimelineKey],
    },
    {
      resource: 'work',
      queryKeys: [salesActivityTimelineKey],
    },
    {
      resource: 'communications',
      queryKeys: [salesActivityTimelineKey],
    },
    {
      resource: 'sales',
      queryKeys: [salesActivityTimelineKey],
    },
  ]);

  const pages = Math.max(1, Math.ceil((timeline.data?.total ?? 0) / query.pageSize));
  const updateQuery = (next: Partial<SalesActivityQuery>) =>
    setQuery((current) => ({ ...current, ...next }));

  if (timeline.isPending)
    return (
      <div className="grid min-h-80 place-items-center">
        <LoaderCircle className="size-5 animate-spin text-blue-600" />
      </div>
    );
  if (timeline.isError || !timeline.data)
    return (
      <Card className="mx-auto max-w-xl border-rose-100 shadow-none">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <TriangleAlert className="size-6 text-rose-600" />
          <p className="mt-3 font-semibold">Activity timeline is unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your scoped activity data could not be loaded. Try again in a moment.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void timeline.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );

  const data = timeline.data;
  return (
    <div className="mx-auto max-w-[1680px]">
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Link href="/sales-consultant/dashboard" className="text-blue-600 hover:underline">
            Home
          </Link>
          <span>›</span>
          <span>Tasks</span>
          <span>›</span>
          <span>Activity timeline</span>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f]">Activity Timeline</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Track every customer interaction across your assigned leads.
            </p>
          </div>
          <Button asChild size="sm" className="shrink-0">
            <Link href="/sales-consultant/my-leads">
              <Send className="size-3.5" /> Open my leads
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="overflow-hidden shadow-none">
          <CardHeader className="border-b px-4 py-3 sm:px-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="text-sm">
                  {data.consultant_name}&apos;s customer activity
                </CardTitle>
                <CardDescription>
                  Events are limited to your assigned opportunities.
                </CardDescription>
              </div>
              <Badge variant="secondary">{data.total} activities</Badge>
            </div>
          </CardHeader>
          <div className="flex max-w-full gap-1 overflow-x-auto border-b px-3 pt-1">
            {activityTabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => updateQuery({ kind: tab.value, page: 1 })}
                className={cn(
                  'shrink-0 border-b-2 px-2.5 py-2.5 text-[11px] font-semibold',
                  query.kind === tab.value
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-muted-foreground hover:text-blue-700',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="grid gap-2 border-b bg-slate-50/60 p-3 md:grid-cols-[minmax(0,1fr)_160px_140px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => updateQuery({ search: event.target.value, page: 1 })}
                className="h-9 bg-white pl-8 text-xs"
                placeholder="Search customer, lead, model or activity"
              />
            </div>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                updateQuery({ sort: value as SalesActivityQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="h-9 bg-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest:desc">Latest first</SelectItem>
                <SelectItem value="oldest:asc">Oldest first</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                updateQuery({ pageSize: Number(value) as SalesActivityQuery['pageSize'], page: 1 })
              }
            >
              <SelectTrigger className="h-9 bg-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 per page</SelectItem>
                <SelectItem value="50">50 per page</SelectItem>
                <SelectItem value="100">100 per page</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div
            className={timeline.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}
          >
            <Timeline data={data} />
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3">
            <span className="text-[11px] text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={query.page === 1}
                onClick={() => updateQuery({ page: query.page - 1 })}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={query.page >= pages}
                onClick={() => updateQuery({ page: query.page + 1 })}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </Card>
        <SideRail data={data} />
      </div>
    </div>
  );
}
