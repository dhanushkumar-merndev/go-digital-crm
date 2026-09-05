'use client';

import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  Search,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { TeamManagerPerformanceSkeleton } from '@/components/skeletons/management-skeletons';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DayPicker, istToday } from '@/components/ui/day-picker';
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
  fetchTeamActivityOverview,
  fetchTeamMemberActivity,
  teamActivityTimelineKey,
  type TeamActivityQuery,
  type TeamMemberActivityOverview,
  type TeamMemberType,
} from './team-manager-activity-api';
import type { SalesActivityKind } from './sales-consultant-activity-api';

const memberTypeLabel: Record<TeamMemberType, string> = {
  SALES_CONSULTANT: 'Sales Consultant',
  TELECALLER_BDC: 'Telecaller / BDC',
};
const memberTypeBadge: Record<TeamMemberType, BadgeVariant> = {
  SALES_CONSULTANT: 'info',
  TELECALLER_BDC: 'violet',
};
const memberTypeToRole: Record<TeamMemberType, 'telecaller' | 'sales-consultant'> = {
  SALES_CONSULTANT: 'sales-consultant',
  TELECALLER_BDC: 'telecaller',
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

const overviewColumns: Array<{ key: SalesActivityKind; label: string }> = [
  { key: 'CALL', label: 'Calls' },
  { key: 'MESSAGE', label: 'Messages' },
  { key: 'FOLLOW_UP', label: 'Follow-ups' },
  { key: 'TASK', label: 'Tasks' },
  { key: 'APPOINTMENT', label: 'Appts' },
  { key: 'QUOTATION', label: 'Quotes' },
];

function overviewValue(member: TeamMemberActivityOverview, kind: SalesActivityKind) {
  switch (kind) {
    case 'CALL':
      return member.calls;
    case 'MESSAGE':
      return member.messages;
    case 'FOLLOW_UP':
      return member.followups;
    case 'TASK':
      return member.tasks;
    case 'APPOINTMENT':
      return member.appointments;
    case 'QUOTATION':
      return member.quotations;
    default:
      return 0;
  }
}

function TeamRoster({
  date,
  onSelectMember,
}: {
  date: string;
  onSelectMember: (memberId: string) => void;
}) {
  const overview = useQuery({
    queryKey: [...teamActivityTimelineKey, 'overview', date],
    queryFn: ({ signal }) => fetchTeamActivityOverview(date, signal),
    placeholderData: keepPreviousData,
  });

  if (overview.isPending) return <TeamManagerPerformanceSkeleton />;
  if (overview.isError || !overview.data)
    return (
      <Card className="mx-auto max-w-xl border-rose-100 shadow-none">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <TriangleAlert className="size-6 text-rose-600" />
          <p className="mt-3 font-semibold">Team activity is unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your team&apos;s activity data could not be loaded. Try again in a moment.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void overview.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );

  const members = overview.data.members;
  const totals = members.reduce(
    (acc, member) => {
      for (const column of overviewColumns) acc[column.key] += overviewValue(member, column.key);
      acc.total += member.total;
      return acc;
    },
    {
      CALL: 0,
      MESSAGE: 0,
      FOLLOW_UP: 0,
      TASK: 0,
      APPOINTMENT: 0,
      QUOTATION: 0,
      total: 0,
    } as Record<SalesActivityKind, number> & { total: number },
  );

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <Card className="shadow-none">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Team
            </p>
            <p className="mt-1 text-xl font-bold text-[#12213f]">{members.length}</p>
          </CardContent>
        </Card>
        {overviewColumns.map((column) => {
          const definition = activityKindDefinitions[column.key];
          const Icon = definition.icon;
          return (
            <Card key={column.key} className="shadow-none">
              <CardContent className="p-3">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Icon className="size-3" /> {column.label}
                </p>
                <p className="mt-1 text-xl font-bold text-[#12213f]">{totals[column.key]}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm">Your team&apos;s activity</CardTitle>
              <CardDescription>
                {activityDayLabel(date)} · tap a member to open their day
              </CardDescription>
            </div>
            <Badge variant="secondary">{members.length} members</Badge>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                {overviewColumns.map((column) => (
                  <TableHead key={column.key} className="text-right">
                    {column.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length ? (
                members.map((member) => (
                  <TableRow
                    key={member.user_id}
                    className="cursor-pointer"
                    onClick={() => onSelectMember(member.user_id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-[11px]">
                            {initials(member.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-semibold text-[#17233d]">{member.full_name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={memberTypeBadge[member.member_type]}>
                        {memberTypeLabel[member.member_type]}
                      </Badge>
                    </TableCell>
                    {overviewColumns.map((column) => (
                      <TableCell key={column.key} className="text-right tabular-nums">
                        {overviewValue(member, column.key)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right text-sm font-bold tabular-nums text-[#12213f]">
                      {member.total}
                    </TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={overviewColumns.length + 4} className="py-16 text-center">
                    <Users className="mx-auto size-7 text-slate-300" />
                    <p className="mt-3 text-sm font-semibold">No team members yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Active Telecallers and Sales Consultants on your team will show up here.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  );
}

function MemberDrilldown({
  memberId,
  date,
  onBack,
}: {
  memberId: string;
  date: string;
  onBack: () => void;
}) {
  const [query, setQuery] = useState<TeamActivityQuery>({
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

  const member = useQuery({
    queryKey: [...teamActivityTimelineKey, 'member', memberId, date, requestQuery],
    queryFn: ({ signal }) => fetchTeamMemberActivity(memberId, date, requestQuery, signal),
    placeholderData: keepPreviousData,
  });

  const updateQuery = (next: Partial<TeamActivityQuery>) =>
    setQuery((current) => ({ ...current, ...next }));

  if (member.isPending) return <TeamManagerPerformanceSkeleton />;
  if (member.isError || !member.data)
    return (
      <Card className="mx-auto max-w-xl border-rose-100 shadow-none">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <TriangleAlert className="size-6 text-rose-600" />
          <p className="mt-3 font-semibold">This member&apos;s activity is unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The data could not be loaded. Try again in a moment.
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="outline" onClick={onBack}>
              Back to team
            </Button>
            <Button variant="outline" onClick={() => void member.refetch()}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );

  const data = member.data;
  const role = memberTypeToRole[data.member_type];
  const roleKinds = roleActivityKinds[role];
  const roleTabs = activityTabsForKinds(roleKinds);
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="icon" className="size-8 shrink-0" onClick={onBack}>
                <ArrowLeft className="size-4" />
              </Button>
              <Avatar className="size-9">
                <AvatarFallback>{initials(data.member_name)}</AvatarFallback>
              </Avatar>
              <div>
                <CardTitle className="text-sm">{data.member_name}&apos;s activity</CardTitle>
                <CardDescription className="flex items-center gap-1.5">
                  <Badge
                    variant={memberTypeBadge[data.member_type]}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {memberTypeLabel[data.member_type]}
                  </Badge>
                  {activityDayLabel(date)}
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary">{data.total} activities</Badge>
          </div>
        </CardHeader>
        <div className="flex max-w-full items-center gap-1 border-b px-3 pt-1">
          <ActivityTabStrip
            tabs={roleTabs}
            active={query.kind}
            onChange={(kind) => updateQuery({ kind, page: 1 })}
          />
        </div>
        <div className="border-b bg-slate-50/60 p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => updateQuery({ search: event.target.value, page: 1 })}
              className="h-9 bg-white pl-8 text-xs"
              placeholder="Search customer, lead, model or activity"
            />
          </div>
        </div>
        <div className={member.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <ActivityTimelineList
            records={data.records}
            emptyTitle="No activity on this day"
            emptyDetail={`Nothing was logged for ${data.member_name} on this day.`}
          />
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

      <aside className="space-y-4">
        <Card className="shadow-none">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-sm">Activity summary</CardTitle>
            <CardDescription>{activityDayLabel(date)}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
            {roleKinds.map((kind) => {
              const definition = activityKindDefinitions[kind];
              const Icon = definition.icon;
              const value =
                kind === 'CALL'
                  ? data.summary.calls
                  : kind === 'MESSAGE'
                    ? data.summary.messages
                    : kind === 'FOLLOW_UP'
                      ? data.summary.followups
                      : kind === 'TEST_DRIVE'
                        ? data.summary.test_drives
                        : kind === 'QUOTATION'
                          ? data.summary.quotations
                          : kind === 'TASK'
                            ? data.summary.tasks
                            : kind === 'APPOINTMENT'
                              ? data.summary.appointments
                              : data.summary.notes;
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
                    <span className="block text-sm font-bold text-[#17233d]">{value}</span>
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-sm">Upcoming follow-ups</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {data.upcoming_followups.length ? (
              data.upcoming_followups.map((item) => (
                <div key={item.id} className="flex items-start gap-2 rounded-md p-1">
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
                </div>
              ))
            ) : (
              <p className="py-5 text-center text-xs text-muted-foreground">
                No follow-ups are scheduled.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-sm">Recent notes</CardTitle>
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
              <p className="py-5 text-center text-xs text-muted-foreground">
                No customer notes yet.
              </p>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

export function TeamManagerActivityTimeline() {
  const [date, setDate] = useState(istToday());
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Link href="/team-manager/dashboard" className="text-blue-600 hover:underline">
            Home
          </Link>
          <span>›</span>
          <span>Team</span>
          <span>›</span>
          <span>Team Activity</span>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12213f]">Team Activity</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              See what each Telecaller and Sales Consultant on your team did, day by day.
            </p>
          </div>
          <DayPicker
            value={date}
            onChange={(value) => setDate(value || istToday())}
            max={istToday()}
          />
        </div>
      </div>

      {selectedMemberId ? (
        <MemberDrilldown
          memberId={selectedMemberId}
          date={date}
          onBack={() => setSelectedMemberId(null)}
        />
      ) : (
        <TeamRoster date={date} onSelectMember={setSelectedMemberId} />
      )}
    </div>
  );
}
