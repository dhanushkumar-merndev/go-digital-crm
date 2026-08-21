'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pencil,
  Phone,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  fetchFollowupCalendar,
  type FollowupRecord,
  type WorkWorkspacePermissions,
} from './workspace-api';
import type { WorkQuery } from './workspace-query';

const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function priorityClasses(record: FollowupRecord) {
  if (record.display_status === 'OVERDUE')
    return 'border-red-200 bg-red-50 text-red-900 hover:bg-red-100';
  if (record.status === 'COMPLETED')
    return 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100';
  if (record.status === 'CANCELLED')
    return 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100';
  if (record.priority === 'URGENT' || record.priority === 'HIGH')
    return 'border-orange-200 bg-orange-50 text-orange-900 hover:bg-orange-100';
  return 'border-blue-200 bg-blue-50 text-blue-900 hover:bg-blue-100';
}

function DetailSheet({
  record,
  role,
  permissions,
  dayLabel,
  onBack,
  onClose,
  onEdit,
  onAction,
}: {
  record: FollowupRecord;
  role: string;
  permissions: WorkWorkspacePermissions;
  dayLabel?: string;
  onBack?: () => void;
  onClose: () => void;
  onEdit: (record: FollowupRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: FollowupRecord) => void;
}) {
  const terminal = record.status !== 'OPEN';
  const canComplete =
    permissions.canComplete &&
    (record.assigned_user_id === permissions.userId || permissions.canOverrideComplete);

  return (
    <>
      <SheetHeader className="border-b">
        {onBack && (
          <button
            type="button"
            className="mb-1 flex w-fit items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" /> {dayLabel}
          </button>
        )}
        <SheetTitle>Follow-up details</SheetTitle>
        <div className="flex flex-wrap gap-2 pt-1">
          <StatusBadge value={record.display_status} />
          <Badge variant="outline" className="text-[10px]">
            {record.priority} priority
          </Badge>
        </div>
      </SheetHeader>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Customer
          </p>
          {record.customer_id ? (
            <Link
              href={`/${role}/customers/${record.customer_id}`}
              className="mt-1 block text-base font-semibold text-blue-700 hover:underline"
            >
              {record.customer_name}
            </Link>
          ) : (
            <p className="mt-1 text-base font-semibold">{record.customer_name}</p>
          )}
          {record.phone && (
            <a
              href={`tel:${record.phone}`}
              className="mt-1 flex items-center gap-1.5 text-sm text-emerald-700 hover:underline"
            >
              <Phone className="size-3.5" /> {record.phone}
            </a>
          )}
        </div>
        <div className="grid gap-4 rounded-lg border bg-slate-50/60 p-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Due</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
              <CalendarDays className="size-3.5 text-blue-600" /> {formatDateTime(record.due_at)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Responsible user</p>
            <p className="mt-1 text-sm font-semibold">{record.assigned_user_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Branch</p>
            <p className="mt-1 text-sm font-semibold">{record.branch_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Interested model</p>
            <p className="mt-1 text-sm font-semibold">{record.interested_model ?? '—'}</p>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Follow-up reason
          </p>
          <p className="mt-2 rounded-lg border p-4 text-sm leading-6">{record.reason}</p>
        </div>
      </div>
      {!terminal && (permissions.canUpdate || canComplete || permissions.canCancel) && (
        <div className="flex flex-wrap justify-end gap-2 border-t p-4">
          {permissions.canUpdate && (
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                onEdit(record);
              }}
            >
              <Pencil className="size-4" /> Reschedule
            </Button>
          )}
          {permissions.canCancel && (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                onClose();
                onAction('cancel', record);
              }}
            >
              Cancel
            </Button>
          )}
          {canComplete && (
            <Button
              onClick={() => {
                onClose();
                onAction('complete', record);
              }}
            >
              Mark complete
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export function FollowupCalendar({
  role,
  query,
  timezone,
  organizationId,
  scopeKey,
  permissions,
  isActive,
  onEdit,
  onAction,
}: {
  role: string;
  query: WorkQuery;
  timezone: string;
  organizationId: string;
  scopeKey: string;
  permissions: WorkWorkspacePermissions;
  isActive: boolean;
  onEdit: (record: FollowupRecord) => void;
  onAction: (action: 'complete' | 'cancel', record: FollowupRecord) => void;
}) {
  const [monthOffset, setMonthOffset] = useState<0 | 1>(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<FollowupRecord | null>(null);
  const displayedMonth = useMemo(() => {
    const value = new Date();
    value.setDate(1);
    value.setMonth(value.getMonth() + monthOffset);
    value.setHours(0, 0, 0, 0);
    return value;
  }, [monthOffset]);
  const displayedMonthKey = monthKey(displayedMonth);
  const calendar = useQuery({
    queryKey: [
      'followup-calendar',
      organizationId,
      scopeKey,
      timezone,
      displayedMonthKey,
      query.search,
      query.status,
      query.priority,
      query.branchId,
      query.teamId,
      query.ownerId,
    ],
    queryFn: () => fetchFollowupCalendar({ month: displayedMonthKey, query, timezone, day: null }),
    enabled: isActive,
  });
  const dayRecords = useQuery({
    queryKey: [
      'followup-calendar-day',
      organizationId,
      scopeKey,
      timezone,
      displayedMonthKey,
      selectedDay,
      query.search,
      query.status,
      query.priority,
      query.branchId,
      query.teamId,
      query.ownerId,
    ],
    queryFn: () =>
      fetchFollowupCalendar({
        month: displayedMonthKey,
        day: selectedDay,
        query,
        timezone,
      }),
    enabled: isActive && Boolean(selectedDay),
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
  const todayKey = dateKey(new Date());
  const selectedDayLabel = selectedDay
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'full' }).format(
        new Date(`${selectedDay}T00:00:00`),
      )
    : '';
  const selectedDayRecords = dayRecords.data?.days[0]?.items ?? [];
  const closeSheet = () => {
    setSelectedRecord(null);
    setSelectedDay(null);
  };

  if (calendar.isError)
    return (
      <div className="grid min-h-80 place-items-center border-t p-8 text-center">
        <div>
          <p className="font-semibold">Calendar could not be loaded</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The month calendar migration or your scoped session needs attention.
          </p>
          <Button variant="outline" className="mt-4" onClick={() => void calendar.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );

  return (
    <>
      <div className="border-t">
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">
                {new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(
                  displayedMonth,
                )}
              </h2>
              <Badge variant="outline" className="text-[10px]">
                {monthOffset === 0 ? 'This month' : 'Next month'}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {calendar.data?.month_total ?? 0} follow-ups in this view
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={monthOffset === 0}
              onClick={() => setMonthOffset(0)}
              aria-label="Show current month"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={monthOffset === 1}
              onClick={() => setMonthOffset(1)}
              aria-label="Show next month"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className={calendar.isFetching ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
          <div className="min-w-[980px]">
            <div className="grid grid-cols-7 border-b bg-slate-50">
              {weekdayLabels.map((label) => (
                <div
                  key={label}
                  className="border-r px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0"
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((cell) => {
                const key = dateKey(cell);
                const day = recordsByDay.get(key);
                const inMonth = cell.getMonth() === displayedMonth.getMonth();
                const hiddenCount = Math.max(0, (day?.total ?? 0) - 3);
                return (
                  <div
                    key={key}
                    className={`min-h-36 border-b border-r p-2 last:border-r-0 ${
                      inMonth ? 'bg-white' : 'bg-slate-50/70'
                    }`}
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span
                        className={`grid size-6 place-items-center rounded-full text-xs font-medium ${
                          key === todayKey
                            ? 'bg-blue-600 text-white'
                            : inMonth
                              ? 'text-foreground'
                              : 'text-muted-foreground/60'
                        }`}
                      >
                        {cell.getDate()}
                      </span>
                      {day?.total ? (
                        <span className="text-[10px] text-muted-foreground">{day.total}</span>
                      ) : null}
                    </div>
                    <div className="space-y-1">
                      {day?.items.map((record) => (
                        <button
                          key={record.id}
                          type="button"
                          className={`block w-full rounded border px-2 py-1.5 text-left transition-colors ${priorityClasses(record)}`}
                          onClick={() => setSelectedRecord(record)}
                        >
                          <span className="flex items-center gap-1 text-[9px] font-semibold">
                            <Clock3 className="size-3" /> {formatTime(record.due_at)}
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] font-semibold">
                            {record.customer_name}
                          </span>
                        </button>
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          className="w-full rounded px-2 py-1 text-left text-[10px] font-semibold text-blue-700 hover:bg-blue-50"
                          onClick={() => setSelectedDay(key)}
                        >
                          +{hiddenCount} more
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <Sheet
        open={Boolean(selectedDay || selectedRecord)}
        onOpenChange={(open) => !open && closeSheet()}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col transition-transform duration-300 data-[state=closed]:translate-x-full data-[state=open]:translate-x-0 sm:w-[440px]"
        >
          {selectedRecord ? (
            <DetailSheet
              record={selectedRecord}
              role={role}
              permissions={permissions}
              dayLabel={selectedDay ? selectedDayLabel : undefined}
              onBack={selectedDay ? () => setSelectedRecord(null) : undefined}
              onClose={closeSheet}
              onEdit={onEdit}
              onAction={onAction}
            />
          ) : (
            <>
              <SheetHeader className="border-b">
                <SheetTitle>{selectedDayLabel}</SheetTitle>
                <p className="text-sm text-muted-foreground">
                  {dayRecords.isFetching
                    ? 'Loading follow-ups…'
                    : `${selectedDayRecords.length} follow-ups`}
                </p>
              </SheetHeader>
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {selectedDayRecords.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${priorityClasses(record)}`}
                    onClick={() => setSelectedRecord(record)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{record.customer_name}</p>
                        <p className="mt-1 truncate text-xs">{record.reason}</p>
                      </div>
                      <span className="shrink-0 text-xs font-semibold">
                        {formatTime(record.due_at)}
                      </span>
                    </div>
                  </button>
                ))}
                {!dayRecords.isFetching && selectedDayRecords.length === 0 && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No follow-ups remain in this filtered day.
                  </p>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
