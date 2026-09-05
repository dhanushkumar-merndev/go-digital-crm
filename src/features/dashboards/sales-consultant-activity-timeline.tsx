'use client';

import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarClock,
  CarFront,
  ChevronLeft,
  ChevronRight,
  FileText,
  MessageCircle,
  NotebookPen,
  Phone,
  Search,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { SalesConsultantTimelineSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DayPicker, istToday } from '@/components/ui/day-picker';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { cn } from '@/lib/utils';
import {
  ActivityTabStrip,
  ActivityTimelineList,
  activityDayLabel,
  activityFullDate,
  activityKindDefinitions,
  activityTabsForKinds,
  roleActivityKinds,
} from './activity-timeline-shared';
import {
  fetchActivityTimelineForDay,
  fetchSalesConsultantActivityTimeline,
  salesActivityTimelineKey,
  type ActivityTimelineRole,
  type SalesActivityKind,
  type SalesActivityQuery,
  type SalesConsultantActivityTimeline,
} from './sales-consultant-activity-api';

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

function SideRail({
  data,
  role,
  selectedDate,
  dayTotals,
}: {
  data: SalesConsultantActivityTimeline;
  role: ActivityTimelineRole;
  selectedDate: string;
  dayTotals: Partial<Record<SalesActivityKind, number>> | null;
}) {
  const rolePath = `/${role}`;
  const roleKinds = roleActivityKinds[role];
  return (
    <aside className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle className="text-sm">Activity summary</CardTitle>
          <CardDescription>
            {selectedDate ? activityDayLabel(selectedDate) : 'Last 7 days'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
          {selectedDate
            ? roleKinds.map((kind) => {
                const definition = activityKindDefinitions[kind];
                const Icon = definition.icon;
                return (
                  <div key={kind} className="flex items-center gap-2">
                    <span
                      className={cn('grid size-7 place-items-center rounded-md', definition.tone)}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span>
                      <span className="block text-[10px] text-muted-foreground">
                        {definition.label.replace(' logged', '').replace(' activity', '')}
                      </span>
                      <span className="block text-sm font-bold text-[#17233d]">
                        {dayTotals?.[kind] ?? 0}
                      </span>
                    </span>
                  </div>
                );
              })
            : summaryItems(data).map(([label, value, Icon, tone]) => (
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
          <Link href={`${rolePath}/follow-ups`} className="text-[11px] font-medium text-blue-600">
            View all
          </Link>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {data.upcoming_followups.length ? (
            data.upcoming_followups.map((item) => (
              <Link
                key={item.id}
                href={`${rolePath}/follow-ups`}
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
                  <span className="block text-[10px] text-slate-500">
                    {activityFullDate(item.due_at)}
                  </span>
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
          <Link href={`${rolePath}/my-leads`} className="text-[11px] font-medium text-blue-600">
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
                    {note.customer_name} · {activityFullDate(note.created_at)}
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

export function SalesConsultantActivityTimeline({
  role = 'sales-consultant',
}: {
  role?: ActivityTimelineRole;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const rolePath = `/${role}`;
  const roleKinds = roleActivityKinds[role];
  const roleTabs = useMemo(() => activityTabsForKinds(roleKinds), [roleKinds]);
  const [query, setQuery] = useState<SalesActivityQuery>({
    search: '',
    kind: 'ALL',
    page: 1,
    pageSize: 25,
    sort: 'latest:desc',
  });
  const [date, setDate] = useState('');
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );

  const timeline = useQuery({
    queryKey: [...salesActivityTimelineKey, role, ...queryScope, requestQuery],
    queryFn: ({ signal }) => fetchSalesConsultantActivityTimeline(requestQuery, role, signal),
    placeholderData: keepPreviousData,
    enabled: !date,
  });
  const dayFeed = useQuery({
    queryKey: [...salesActivityTimelineKey, 'day', role, ...queryScope, date],
    queryFn: ({ signal }) => fetchActivityTimelineForDay(role, date, signal),
    enabled: Boolean(date),
    placeholderData: keepPreviousData,
  });
  useTenantRealtimeInvalidation(timeline.data?.organization_id ?? dayFeed.data?.organization_id, [
    {
      resource: 'leads',
      queryKeys: [[...salesActivityTimelineKey, role, ...queryScope]],
    },
    {
      resource: 'work',
      queryKeys: [[...salesActivityTimelineKey, role, ...queryScope]],
    },
    {
      resource: 'communications',
      queryKeys: [[...salesActivityTimelineKey, role, ...queryScope]],
    },
    {
      resource: 'sales',
      queryKeys: [[...salesActivityTimelineKey, role, ...queryScope]],
    },
  ]);

  const pages = Math.max(1, Math.ceil((timeline.data?.total ?? 0) / query.pageSize));
  const updateQuery = (next: Partial<SalesActivityQuery>) =>
    setQuery((current) => ({ ...current, ...next }));

  // Day mode filters (kind tab + search) apply client-side over the already
  // fetched day feed, since fetchActivityTimelineForDay always pulls the full
  // day (kind=ALL) so the summary tiles stay accurate regardless of the tab.
  // Computed above any early return so hook order stays stable across renders.
  const day = dayFeed.data;
  const dayRecords = useMemo(() => {
    if (!day) return [];
    const search = debouncedSearch.trim().toLowerCase();
    return day.records.filter((record) => {
      if (query.kind !== 'ALL' && record.activity_kind !== query.kind) return false;
      if (!search) return true;
      return (
        record.customer_name.toLowerCase().includes(search) ||
        record.lead_reference.toLowerCase().includes(search) ||
        (record.interested_model ?? '').toLowerCase().includes(search) ||
        (record.detail ?? '').toLowerCase().includes(search)
      );
    });
  }, [day, query.kind, debouncedSearch]);

  const isLoading = date ? dayFeed.isPending : timeline.isPending;
  const isError = date ? dayFeed.isError || !dayFeed.data : timeline.isError || !timeline.data;

  if (isLoading) return <SalesConsultantTimelineSkeleton />;
  if (isError)
    return (
      <Card className="mx-auto max-w-xl border-rose-100 shadow-none">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <TriangleAlert className="size-6 text-rose-600" />
          <p className="mt-3 font-semibold">Activity timeline is unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your scoped activity data could not be loaded. Try again in a moment.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => void (date ? dayFeed.refetch() : timeline.refetch())}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );

  const consultantName = date ? day?.consultant_name : timeline.data?.consultant_name;
  const totalCount = date ? dayRecords.length : (timeline.data?.total ?? 0);
  const isFetching = date ? dayFeed.isFetching : timeline.isFetching;

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Link href={`${rolePath}/dashboard`} className="text-blue-600 hover:underline">
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
            <Link href={`${rolePath}/my-leads`}>
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
                <CardTitle className="text-sm">{consultantName}&apos;s customer activity</CardTitle>
                <CardDescription>
                  Events are limited to your assigned opportunities.
                </CardDescription>
              </div>
              <Badge variant="secondary">{totalCount} activities</Badge>
            </div>
          </CardHeader>
          <div className="flex max-w-full items-center gap-1 border-b px-3 pt-1">
            <ActivityTabStrip
              tabs={roleTabs}
              active={query.kind}
              onChange={(kind) => updateQuery({ kind, page: 1 })}
            />
          </div>
          <div className="grid gap-2 border-b bg-slate-50/60 p-3 md:grid-cols-[minmax(0,1fr)_auto_140px_130px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => updateQuery({ search: event.target.value, page: 1 })}
                className="h-9 bg-white pl-8 text-xs"
                placeholder="Search customer, lead, model or activity"
              />
            </div>
            <DayPicker value={date} onChange={setDate} max={istToday()} />
            <Select
              value={query.sort}
              onValueChange={(value) =>
                updateQuery({ sort: value as SalesActivityQuery['sort'], page: 1 })
              }
              disabled={Boolean(date)}
            >
              <SelectTrigger className="h-9 bg-white text-xs disabled:opacity-50">
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
              disabled={Boolean(date)}
            >
              <SelectTrigger className="h-9 bg-white text-xs disabled:opacity-50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 per page</SelectItem>
                <SelectItem value="50">50 per page</SelectItem>
                <SelectItem value="100">100 per page</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {date && day?.truncated && (
            <p className="border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-700">
              This day has a lot of activity — showing the most recent {day.records.length} events
              for it.
            </p>
          )}
          <div className={isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <ActivityTimelineList
              records={date ? dayRecords : (timeline.data?.records ?? [])}
              emptyTitle={date ? 'No activity on this day' : 'No matching activity'}
              emptyDetail={
                date
                  ? 'Nothing was logged for the selected leads on this day.'
                  : 'New events from your assigned leads will appear here.'
              }
            />
          </div>
          {!date && (
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
          )}
        </Card>
        {(timeline.data || day) && (
          <SideRail
            data={
              timeline.data ?? {
                organization_id: day!.organization_id,
                consultant_name: day!.consultant_name,
                records: [],
                total: 0,
                summary: {
                  calls: 0,
                  messages: 0,
                  followups: 0,
                  test_drives: 0,
                  quotations: 0,
                  notes: 0,
                },
                upcoming_followups: day!.upcoming_followups,
                recent_notes: day!.recent_notes,
              }
            }
            role={role}
            selectedDate={date}
            dayTotals={day?.totalsByKind ?? null}
          />
        )}
      </div>
    </div>
  );
}
