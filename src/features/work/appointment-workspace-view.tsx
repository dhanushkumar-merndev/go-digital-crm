'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CarFront,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Phone,
  Search,
  Video,
} from 'lucide-react';
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
  fetchAppointmentTypeSummary,
  type AppointmentRecord,
  type AppointmentWorkspaceResult,
  type WorkRecord,
  type WorkWorkspacePermissions,
} from './workspace-api';
import { appointmentFilters, type WorkQuery, type WorkStatusFilter } from './workspace-query';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const appointmentTypes = ['Showroom Visit', 'Video Call', 'Test Drive', 'Consultant Call'] as const;

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
          <p className="mt-1 text-sm font-semibold">{record.appointment_type}</p>
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
  onQueryChange,
  permissions,
  isFetching,
  onEdit,
  onAction,
  view,
  timezone,
  organizationId,
  scopeKey,
}: {
  role: string;
  result: AppointmentWorkspaceResult;
  query: WorkQuery;
  onQueryChange: (next: Partial<WorkQuery>) => void;
  permissions: WorkWorkspacePermissions;
  isFetching: boolean;
  onEdit: (record: WorkRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: WorkRecord) => void;
  view: 'table' | 'calendar';
  timezone: string;
  organizationId: string;
  scopeKey: string;
}) {
  const [displayedMonth, setDisplayedMonth] = useState(() => {
    const value = new Date();
    value.setDate(1);
    value.setHours(0, 0, 0, 0);
    return value;
  });
  const [selectedDay, setSelectedDay] = useState(() => dateKey(new Date()));
  const [selectedRecord, setSelectedRecord] = useState<AppointmentRecord | null>(null);
  const summary = useQuery({
    queryKey: ['appointment-type-summary', organizationId, scopeKey, timezone],
    queryFn: () => fetchAppointmentTypeSummary(timezone),
  });
  const calendar = useQuery({
    queryKey: [
      'appointment-calendar',
      organizationId,
      scopeKey,
      timezone,
      monthKey(displayedMonth),
      query.search,
      query.status,
      query.appointmentType,
      query.branchId,
      query.teamId,
      query.ownerId,
    ],
    queryFn: () => fetchAppointmentCalendar({ month: monthKey(displayedMonth), query, timezone }),
  });
  const dayRecords = useQuery({
    queryKey: [
      'appointment-calendar-day',
      organizationId,
      scopeKey,
      timezone,
      monthKey(displayedMonth),
      selectedDay,
      query.search,
      query.status,
      query.appointmentType,
      query.branchId,
      query.teamId,
      query.ownerId,
    ],
    queryFn: () =>
      fetchAppointmentCalendar({
        month: monthKey(displayedMonth),
        day: selectedDay,
        query,
        timezone,
      }),
    enabled: Boolean(selectedDay),
  });
  const recordsByDay = useMemo(
    () => new Map(calendar.data?.days.map((day) => [day.date, day]) ?? []),
    [calendar.data?.days],
  );
  const firstWeekday = (displayedMonth.getDay() + 6) % 7;
  const firstCell = new Date(displayedMonth);
  firstCell.setDate(1 - firstWeekday);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(firstCell);
    value.setDate(firstCell.getDate() + index);
    return value;
  });
  const today = dateKey(new Date());
  const selectedItems = dayRecords.data?.days[0]?.items ?? [];
  const typeCounts = summary.data ?? {
    showroom_visit: 0,
    video_call: 0,
    test_drive: 0,
    consultant_call: 0,
  };
  const cards = [
    { type: 'Showroom Visit' as const, value: typeCounts.showroom_visit },
    { type: 'Video Call' as const, value: typeCounts.video_call },
    { type: 'Test Drive' as const, value: typeCounts.test_drive },
    { type: 'Consultant Call' as const, value: typeCounts.consultant_call },
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
    <Card className="shadow-none">
      <CardContent className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-6">
        <div className="relative xl:col-span-2">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query.search}
            onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
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
          <SelectTrigger>
            <SelectValue />
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
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {appointmentFilters.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'all' ? 'All statuses' : status.replaceAll('-', ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex h-10 items-center gap-2 rounded-md border bg-slate-50 px-3 text-xs">
          <Building2 className="size-4 text-blue-600" />
          <span className="truncate">
            {result.filters.branches[0]?.name ?? 'Assigned dealership'}
          </span>
        </div>
        <Button
          variant="ghost"
          className="justify-self-start text-blue-700"
          onClick={() =>
            onQueryChange({ search: '', appointmentType: 'all', status: 'all', page: 1 })
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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ type, value }) => {
          const visual = typeVisual(type);
          const Icon = visual.icon;
          return (
            <Card key={type} className="shadow-none">
              <CardContent className="flex items-center gap-4 p-4">
                <div className={`grid size-12 place-items-center rounded-full ${visual.tone}`}>
                  <Icon className="size-5" />
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{type}</p>
                  <p className="mt-1 text-2xl font-bold">{value}</p>
                  <p className="mt-1 text-[11px] text-emerald-600">Today in your scope</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {filters}
      {view === 'table' ? (
        <div className="grid gap-4 xl:grid-cols-12">
          <Card className="overflow-hidden shadow-none xl:col-span-9">
            <CardHeader className="flex-row items-center justify-between border-b p-4">
              <CardTitle className="text-sm">Appointments ({result.total})</CardTitle>
              <span className="text-xs text-muted-foreground">
                Showing {result.total ? (query.page - 1) * query.pageSize + 1 : 0}–
                {Math.min(query.page * query.pageSize, result.total)}
              </span>
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
                      <TableHead>Consultant</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.records.length ? (
                      result.records.map((record) => {
                        const visual = typeVisual(record.appointment_type);
                        const Icon = visual.icon;
                        return (
                          <TableRow key={record.id}>
                            <TableCell>
                              <Link
                                href={`/${role}/customers/${record.customer_id}`}
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
                                {record.appointment_type}
                              </span>
                            </TableCell>
                            <TableCell>{formatDate(record.scheduled_at)}</TableCell>
                            <TableCell>{formatTime(record.scheduled_at)}</TableCell>
                            <TableCell>{record.interested_model ?? '—'}</TableCell>
                            <TableCell>{record.assigned_user_name}</TableCell>
                            <TableCell>{record.branch_name}</TableCell>
                            <TableCell>
                              <StatusBadge value={record.status} />
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
                        <TableCell colSpan={9} className="h-40 text-center">
                          No matching appointments
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
                <span>
                  Showing {result.total ? (query.page - 1) * query.pageSize + 1 : 0}–
                  {Math.min(query.page * query.pageSize, result.total)} of {result.total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    disabled={query.page <= 1}
                    onClick={() => onQueryChange({ page: query.page - 1 })}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span>
                    Page {query.page} of {Math.max(1, Math.ceil(result.total / query.pageSize))}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    disabled={query.page >= Math.ceil(result.total / query.pageSize)}
                    onClick={() => onQueryChange({ page: query.page + 1 })}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
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
                      className="py-1 text-center text-[9px] font-semibold text-muted-foreground"
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
                  <span className="ml-1 text-muted-foreground">{selectedItems.length}</span>
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
                          {record.appointment_type} · {record.interested_model ?? 'No model'}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {!dayRecords.isFetching && !selectedItems.length && (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    No appointments for this day.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <Card className="overflow-hidden shadow-none">
          {monthHeader}
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <div className="min-w-[980px]">
                <div className="grid grid-cols-7 border-b bg-slate-50">
                  {weekdays.map((day) => (
                    <div
                      key={day}
                      className="border-r px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground"
                    >
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7">
                  {cells.map((cell) => {
                    const key = dateKey(cell);
                    const day = recordsByDay.get(key);
                    const inMonth = cell.getMonth() === displayedMonth.getMonth();
                    return (
                      <div
                        key={key}
                        className={`min-h-36 border-b border-r p-2 ${inMonth ? 'bg-white' : 'bg-slate-50/70'}`}
                      >
                        <button
                          className={`grid size-6 place-items-center rounded-full text-xs ${key === today ? 'bg-blue-600 text-white' : ''}`}
                          onClick={() => selectCalendarDay(cell)}
                        >
                          {cell.getDate()}
                        </button>
                        <div className="mt-1.5 space-y-1">
                          {day?.items.map((record) => {
                            const visual = typeVisual(record.appointment_type);
                            return (
                              <button
                                key={record.id}
                                className={`block w-full rounded border px-2 py-1 text-left text-[10px] ${visual.border}`}
                                onClick={() => setSelectedRecord(record)}
                              >
                                <span className="font-semibold">
                                  {formatTime(record.scheduled_at)}
                                </span>
                                <span className="block truncate">{record.customer_name}</span>
                              </button>
                            );
                          })}
                          {(day?.total ?? 0) > 3 && (
                            <button
                              className="text-[10px] font-semibold text-blue-700"
                              onClick={() => setSelectedDay(key)}
                            >
                              +{(day?.total ?? 0) - 3} more
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
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
