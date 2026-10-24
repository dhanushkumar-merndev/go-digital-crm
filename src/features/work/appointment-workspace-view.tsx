'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { formatNumber } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarClock,
  CalendarDays,
  CarFront,
  CheckCheck,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Phone,
  MapPinCheck,
  Search,
  UserX,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Tone } from '@/features/dashboards/dashboard-tone';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fetchAppointmentCalendar,
  type AppointmentRecord,
  type AppointmentWorkspaceResult,
  type WorkRecord,
  type WorkWorkspacePermissions,
} from './workspace-api';
import {
  appointmentFilters,
  schedulableAppointmentTypes,
  type WorkQuery,
  type WorkStatusFilter,
} from './workspace-query';
import { recordDetailHref } from '@/lib/navigation/record-links';
import { focusRowElementId, focusedRowClassName } from '@/lib/navigation/focus-row';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const appointmentTypes = schedulableAppointmentTypes;

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A visit from an earlier day that nobody marked done, missed or cancelled. It
 * still reads "Scheduled" in the data, which on a past date looked like a
 * booking still to come.
 */
function isOverdueAppointment(record: AppointmentRecord) {
  if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(record.status)) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(record.scheduled_at) < startOfToday;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}

/** "Showroom Visit" → "Showroom visit": the stored names are Title Case. */
function typeLabel(type: AppointmentRecord['appointment_type']) {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

function typeVisual(type: AppointmentRecord['appointment_type']) {
  if (type === 'Showroom Visit')
    return {
      icon: Building2,
      tone: 'bg-violet-50 text-violet-600',
      border: 'border-violet-200 bg-violet-50',
    };
  if (type === 'Video Call')
    return { icon: Video, tone: 'bg-blue-50 text-blue-600', border: 'border-blue-200 bg-blue-50' };
  if (type === 'Test Drive')
    return {
      icon: CarFront,
      tone: 'bg-orange-50 text-orange-600',
      border: 'border-orange-200 bg-orange-50',
    };
  return {
    icon: Phone,
    tone: 'bg-emerald-50 text-emerald-600',
    border: 'border-emerald-200 bg-emerald-50',
  };
}

function AppointmentActions({
  record,
  permissions,
  onEdit,
  onAction,
}: {
  record: AppointmentRecord;
  permissions: WorkWorkspacePermissions;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
}) {
  const terminal = ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(record.status);
  return (
    <div className="flex items-center gap-0.5">
      {record.phone && (
        <Button variant="ghost" size="icon" className="size-7 text-emerald-600" asChild>
          <a href={`tel:${record.phone}`} aria-label={`Call ${record.customer_name}`}>
            <Phone className="size-3.5" />
          </a>
        </Button>
      )}
      {!terminal && permissions.canUpdate && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-blue-600"
          onClick={() => onEdit(record)}
          aria-label="Edit appointment"
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      {!terminal && (permissions.canComplete || permissions.canCancel) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {permissions.canComplete && (
              <DropdownMenuItem onSelect={() => onAction('complete', record)}>
                Mark complete
              </DropdownMenuItem>
            )}
            {permissions.canCancel && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => onAction('cancel', record)}
                >
                  Cancel appointment
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function AppointmentDetail({
  record,
  role,
  permissions,
  onEdit,
  onAction,
}: {
  record: AppointmentRecord;
  role: string;
  permissions: WorkWorkspacePermissions;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
}) {
  const visual = typeVisual(record.appointment_type);
  const Icon = visual.icon;
  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start gap-3">
        <div className={`grid size-11 place-items-center rounded-lg ${visual.tone}`}>
          <Icon className="size-5" />
        </div>
        <div>
          <p className="font-semibold">{record.customer_name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {record.phone ?? 'Phone unavailable'}
          </p>
        </div>
      </div>
      <div className="grid gap-4 rounded-lg border bg-slate-50 p-4 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">Appointment</p>
          <p className="mt-1 text-sm font-semibold">{typeLabel(record.appointment_type)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Scheduled</p>
          <p className="mt-1 text-sm font-semibold">
            {formatDate(record.scheduled_at)}, {formatTime(record.scheduled_at)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Consultant</p>
          <p className="mt-1 text-sm font-semibold">{record.assigned_user_name}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Branch</p>
          <p className="mt-1 text-sm font-semibold">{record.branch_name}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Model</p>
          <p className="mt-1 text-sm font-semibold">{record.interested_model ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Status</p>
          <div className="mt-1">
            <StatusBadge value={record.status} />
          </div>
        </div>
      </div>
      {record.notes && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </p>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border p-3 text-sm">{record.notes}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/${role}/customers/${record.customer_id}`}>Customer 360</Link>
        </Button>
        <AppointmentActions
          record={record}
          permissions={permissions}
          onEdit={onEdit}
          onAction={onAction}
        />
      </div>
    </div>
  );
}

export function AppointmentWorkspaceView({
  role,
  result,
  query,
  requestQuery,
  onQueryChange,
  permissions,
  isFetching,
  onEdit,
  onAction,
  timezone,
  organizationId,
  scopeKey,
  focusedRowIds,
}: {
  role: string;
  result: AppointmentWorkspaceResult;
  query: WorkQuery;
  requestQuery: WorkQuery;
  onQueryChange: (next: Partial<WorkQuery>) => void;
  permissions: WorkWorkspacePermissions;
  isFetching: boolean;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
  timezone: string;
  organizationId: string;
  scopeKey: string;
  focusedRowIds: ReadonlySet<string>;
}) {
  // A consultant's or telecaller's own list: the consultant and branch are the
  // same on every row, so those columns are left out.
  const personal = role === 'sales-consultant' || role === 'telecaller';
  const [displayedMonth, setDisplayedMonth] = useState(() => {
    const value = new Date();
    value.setDate(1);
    value.setHours(0, 0, 0, 0);
    return value;
  });
  const [selectedDay, setSelectedDay] = useState(() => dateKey(new Date()));
  const [selectedRecord, setSelectedRecord] = useState<AppointmentRecord | null>(null);
  const calendar = useQuery({
    queryKey: [
      'appointment-calendar',
      organizationId,
      permissions.userId,
      scopeKey,
      timezone,
      monthKey(displayedMonth),
      requestQuery.search,
      requestQuery.status,
      requestQuery.appointmentType,
      requestQuery.branchId,
      requestQuery.teamId,
      requestQuery.ownerId,
    ],
    queryFn: ({ signal }) =>
      fetchAppointmentCalendar(
        { month: monthKey(displayedMonth), query: requestQuery, timezone },
        signal,
      ),
  });
  const recordsByDay = useMemo(
    () => new Map(calendar.data?.days.map((day) => [day.date, day]) ?? []),
    [calendar.data?.days],
  );
  // The month already carries up to three appointments a day, so a day with
  // three or fewer needs no second request.
  const monthDay = recordsByDay.get(selectedDay);
  const monthHasDay = calendar.isSuccess && (!monthDay || monthDay.items.length >= monthDay.total);
  const dayRecords = useQuery({
    queryKey: [
      'appointment-calendar-day',
      organizationId,
      permissions.userId,
      scopeKey,
      timezone,
      monthKey(displayedMonth),
      selectedDay,
      requestQuery.search,
      requestQuery.status,
      requestQuery.appointmentType,
      requestQuery.branchId,
      requestQuery.teamId,
      requestQuery.ownerId,
    ],
    queryFn: ({ signal }) =>
      fetchAppointmentCalendar(
        {
          month: monthKey(displayedMonth),
          day: selectedDay,
          query: requestQuery,
          timezone,
        },
        signal,
      ),
    enabled: Boolean(selectedDay) && calendar.isSuccess && !monthHasDay,
  });
  const firstWeekday = (displayedMonth.getDay() + 6) % 7;
  const firstCell = new Date(displayedMonth);
  firstCell.setDate(1 - firstWeekday);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(firstCell);
    value.setDate(firstCell.getDate() + index);
    return value;
  });
  const today = dateKey(new Date());
  const selectedItems = monthHasDay
    ? (monthDay?.items ?? [])
    : (dayRecords.data?.days[0]?.items ?? []);
  const agendaLoading = !monthHasDay && !dayRecords.data;
  // Six tiles, as on every Sales list page, read from the page RPC's own KPI
  // bundle rather than a second per-type summary call.
  const cards: Array<{
    label: string;
    value: number;
    status: WorkStatusFilter;
    helper: string;
    icon: LucideIcon;
    tone: Tone;
  }> = [
    {
      label: 'Today',
      value: result.kpis.today,
      status: 'today',
      helper: 'Scheduled for today',
      icon: CalendarDays,
      tone: 'blue',
    },
    {
      label: 'Upcoming',
      value: result.kpis.upcoming,
      status: 'upcoming',
      helper: 'After today',
      icon: CalendarClock,
      tone: 'violet',
    },
    {
      label: 'Confirmed',
      value: result.kpis.confirmed,
      status: 'confirmed',
      helper: 'Customer confirmed',
      icon: CircleCheck,
      tone: 'cyan',
    },
    {
      label: 'Arrived',
      value: result.kpis.arrived,
      status: 'arrived',
      helper: 'Customer at the showroom',
      icon: MapPinCheck,
      tone: 'amber',
    },
    {
      label: 'Completed',
      value: result.kpis.completed,
      status: 'completed',
      helper: 'Visit or call done',
      icon: CheckCheck,
      tone: 'emerald',
    },
    {
      label: 'No show',
      value: result.kpis.no_show,
      status: 'no-show',
      helper: 'Customer missed it',
      icon: UserX,
      tone: 'rose',
    },
  ];
  const moveMonth = (delta: number) =>
    setDisplayedMonth((current) => {
      const next = new Date(current);
      next.setMonth(next.getMonth() + delta);
      setSelectedDay(dateKey(next));
      return next;
    });
  const selectCalendarDay = (cell: Date) => {
    if (
      cell.getMonth() !== displayedMonth.getMonth() ||
      cell.getFullYear() !== displayedMonth.getFullYear()
    ) {
      const month = new Date(cell);
      month.setDate(1);
      month.setHours(0, 0, 0, 0);
      setDisplayedMonth(month);
    }
    setSelectedDay(dateKey(cell));
  };

  const filters = (
    <Card className="sales-consultant-list-card shadow-none">
      <CardContent
        className={`grid gap-3 p-4 md:grid-cols-2 ${role === 'sales-consultant' ? 'xl:grid-cols-5' : 'xl:grid-cols-6'}`}
      >
        <div className="relative xl:col-span-2">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query.search}
            onChange={(event) =>
              onQueryChange({ search: event.target.value, appointmentId: '', page: 1 })
            }
            placeholder="Search customer or mobile…"
          />
        </div>
        <Select
          value={query.appointmentType}
          onValueChange={(appointmentType) =>
            onQueryChange({
              appointmentType: appointmentType as WorkQuery['appointmentType'],
              page: 1,
            })
          }
        >
          <SelectTrigger aria-label="Appointment type filter">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">Type:</span>
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {appointmentTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.status}
          onValueChange={(status) => onQueryChange({ status: status as WorkStatusFilter, page: 1 })}
        >
          <SelectTrigger aria-label="Appointment status filter">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">Status:</span>
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {appointmentFilters.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'all'
                  ? 'All statuses'
                  : status.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {role !== 'sales-consultant' && (
          <div className="flex h-10 items-center gap-2 rounded-md border bg-slate-50 px-3 text-xs">
            <Building2 className="size-4 text-blue-600" />
            <span className="truncate">
              {result.filters.branches[0]?.name ?? 'Assigned dealership'}
            </span>
          </div>
        )}
        <Button
          variant="ghost"
          className="justify-self-start text-blue-700"
          onClick={() =>
            onQueryChange({
              search: '',
              appointmentId: '',
              appointmentType: 'all',
              status: 'all',
              page: 1,
            })
          }
        >
          Clear filters
        </Button>
      </CardContent>
    </Card>
  );

  const monthHeader = (
    <div className="flex items-center justify-between border-b px-4 py-3">
      <h3 className="font-semibold">
        {new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
          displayedMonth,
        )}
      </h3>
      <div className="flex gap-1">
        <Button variant="outline" size="icon" className="size-8" onClick={() => moveMonth(-1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button variant="outline" size="icon" className="size-8" onClick={() => moveMonth(1)}>
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <KpiGrid
        metrics={cards.map(({ label, value, status, helper, icon, tone }) => ({
          label,
          value: formatNumber(value),
          helper,
          icon,
          tone,
          href: `?status=${status}`,
        }))}
      />
      {filters}
      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="sales-consultant-list-card overflow-hidden shadow-none xl:col-span-9">
          <CardHeader className="flex-row items-center justify-between border-b p-4">
            <CardTitle className="text-sm">Appointments ({formatNumber(result.total)})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className={isFetching ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Appointment type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Model</TableHead>
                    {personal ? null : (
                      <>
                        <TableHead>Consultant</TableHead>
                        <TableHead>Branch</TableHead>
                      </>
                    )}
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.records.length ? (
                    result.records.map((record) => {
                      const visual = typeVisual(record.appointment_type);
                      const Icon = visual.icon;
                      const focused = focusedRowIds.has(record.id);
                      return (
                        <TableRow
                          key={record.id}
                          id={focusRowElementId('appointments', record.id)}
                          className={focused ? focusedRowClassName : undefined}
                        >
                          <TableCell>
                            <Link
                              href={recordDetailHref(role, record) ?? '#'}
                              className="font-semibold hover:text-blue-700 hover:underline"
                            >
                              {record.customer_name}
                            </Link>
                            <p className="text-[10px] text-muted-foreground">
                              {record.phone ?? '—'}
                            </p>
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span
                                className={`grid size-6 place-items-center rounded ${visual.tone}`}
                              >
                                <Icon className="size-3.5" />
                              </span>
                              {typeLabel(record.appointment_type)}
                            </span>
                          </TableCell>
                          <TableCell>{formatDate(record.scheduled_at)}</TableCell>
                          <TableCell>{formatTime(record.scheduled_at)}</TableCell>
                          <TableCell>{record.interested_model ?? '—'}</TableCell>
                          {personal ? null : (
                            <>
                              <TableCell>{record.assigned_user_name}</TableCell>
                              <TableCell>{record.branch_name}</TableCell>
                            </>
                          )}
                          <TableCell>
                            <StatusBadge
                              value={isOverdueAppointment(record) ? 'OVERDUE' : record.status}
                            />
                          </TableCell>
                          <TableCell>
                            <AppointmentActions
                              record={record}
                              permissions={permissions}
                              onEdit={onEdit}
                              onAction={onAction}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={personal ? 7 : 9} className="h-40 text-center">
                        No matching appointments
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <TablePagination
              page={query.page}
              pageSize={query.pageSize}
              total={result.total}
              onPageChange={(page) => onQueryChange({ page })}
            />
          </CardContent>
        </Card>
        <div className="space-y-4 xl:col-span-3">
          <Card className="overflow-hidden shadow-none">
            {monthHeader}
            <CardContent className="p-3">
              <div className="grid grid-cols-7">
                {weekdays.map((day) => (
                  <span
                    key={day}
                    className="py-1 text-center text-[10px] font-semibold text-muted-foreground"
                  >
                    {day.slice(0, 2)}
                  </span>
                ))}
                {cells.map((cell) => {
                  const key = dateKey(cell);
                  const inMonth = cell.getMonth() === displayedMonth.getMonth();
                  const hasItems = Boolean(recordsByDay.get(key)?.total);
                  return (
                    <button
                      key={key}
                      className={`relative grid aspect-square place-items-center rounded-full text-[11px] ${key === selectedDay ? 'bg-blue-600 text-white' : key === today ? 'font-bold text-blue-700' : inMonth ? 'hover:bg-blue-50' : 'text-muted-foreground/40'}`}
                      onClick={() => selectCalendarDay(cell)}
                    >
                      {cell.getDate()}
                      {hasItems && key !== selectedDay && (
                        <span className="absolute bottom-0.5 size-1 rounded-full bg-blue-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader className="border-b p-4">
              <CardTitle className="text-sm">
                {selectedDay === today ? "Today's agenda" : 'Selected-day agenda'}{' '}
                {agendaLoading ? null : (
                  <span className="ml-1 text-muted-foreground">{selectedItems.length}</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-3">
              {selectedItems.slice(0, 6).map((record) => {
                const visual = typeVisual(record.appointment_type);
                const Icon = visual.icon;
                return (
                  <button
                    key={record.id}
                    className="flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-slate-50"
                    onClick={() => setSelectedRecord(record)}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded ${visual.tone}`}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold">
                        {formatTime(record.scheduled_at)} · {record.customer_name}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {typeLabel(record.appointment_type)} ·{' '}
                        {record.interested_model ?? 'No model'}
                      </span>
                    </span>
                  </button>
                );
              })}
              {agendaLoading ? (
                <div className="space-y-2" aria-label="Loading the day's appointments">
                  {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                  ))}
                </div>
              ) : null}
              {!agendaLoading && !selectedItems.length && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No appointments for this day.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <Sheet
        open={Boolean(selectedRecord)}
        onOpenChange={(open) => !open && setSelectedRecord(null)}
      >
        <SheetContent
          side="right"
          className="w-[min(420px,calc(100vw-24px))] overflow-y-auto sm:max-w-[420px]"
        >
          <SheetHeader className="border-b">
            <SheetTitle>Appointment details</SheetTitle>
          </SheetHeader>
          {selectedRecord && (
            <AppointmentDetail
              record={selectedRecord}
              role={role}
              permissions={permissions}
              onEdit={onEdit}
              onAction={onAction}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
