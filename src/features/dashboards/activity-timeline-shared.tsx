'use client';

import {
  CalendarCheck2,
  CalendarClock,
  CarFront,
  ClipboardList,
  FileText,
  MessageCircle,
  NotebookPen,
  Phone,
  SquareCheckBig,
} from 'lucide-react';
import { useMemo } from 'react';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import { Button } from '@/components/ui/button';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { SalesActivityKind } from './sales-consultant-activity-api';

export type ActivityTimelineRecord = {
  id: string;
  activity_type: string;
  activity_kind: SalesActivityKind;
  detail: string | null;
  occurred_at: string;
  customer_name: string;
  customer_phone: string | null;
  lead_reference: string;
  interested_model: string | null;
  actor_name: string | null;
};

export const activityKindDefinitions: Record<
  SalesActivityKind,
  { label: string; icon: typeof Phone; tone: string }
> = {
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

/**
 * Which activity tabs a role is allowed to filter by. Every role's console
 * only does a handful of things day to day, so the timeline mirrors that
 * instead of surfacing kinds the role never produces.
 */
export const roleActivityKinds: Record<'telecaller' | 'sales-consultant', SalesActivityKind[]> = {
  telecaller: ['CALL', 'FOLLOW_UP', 'TASK', 'MESSAGE'],
  'sales-consultant': ['TASK', 'FOLLOW_UP', 'APPOINTMENT', 'QUOTATION'],
};

const kindTabLabels: Record<SalesActivityKind, string> = {
  CALL: 'Calls',
  MESSAGE: 'Messages',
  FOLLOW_UP: 'Follow-ups',
  TEST_DRIVE: 'Test drives',
  QUOTATION: 'Quotations',
  TASK: 'Tasks',
  APPOINTMENT: 'Appointments',
  NOTE: 'Notes',
  OTHER: 'Other',
};

export function activityTabsForKinds(
  kinds: SalesActivityKind[],
): Array<{ value: 'ALL' | SalesActivityKind; label: string }> {
  return [
    { value: 'ALL' as const, label: 'All activities' },
    ...kinds.map((kind) => ({ value: kind, label: kindTabLabels[kind] })),
  ];
}

export function dateHeading(value: string) {
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

export function activityTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

export function activityFullDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

/** "4 September 2026" for a yyyy-mm-dd day key, read as noon IST to dodge DST/offset edge cases. */
export function activityDayLabel(dayKey: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(`${dayKey}T12:00:00+05:30`));
}

/** yyyy-mm-dd for a record's occurred_at, in the app's Asia/Kolkata timezone. */
export function activityDayKey(value: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

function TimelineRecordRow({ record }: { record: ActivityTimelineRecord }) {
  const definition = activityKindDefinitions[record.activity_kind];
  const Icon = definition.icon;
  return (
    <div className="relative grid grid-cols-[58px_34px_minmax(0,1fr)_auto] gap-3 py-3 first:pt-1">
      <p className="pt-2 text-right text-[11px] font-medium text-muted-foreground">
        {activityTime(record.occurred_at)}
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

export function ActivityTimelineList({
  records,
  emptyTitle = 'No matching activity',
  emptyDetail = 'New events from these leads will appear here.',
}: {
  records: ActivityTimelineRecord[];
  emptyTitle?: string;
  emptyDetail?: string;
}) {
  const groups = useMemo(() => {
    const next = new Map<string, ActivityTimelineRecord[]>();
    for (const record of records) {
      const key = new Date(record.occurred_at).toDateString();
      next.set(key, [...(next.get(key) ?? []), record]);
    }
    return [...next.values()];
  }, [records]);

  if (!records.length)
    return (
      <div className="py-20 text-center">
        <ClipboardList className="mx-auto size-7 text-slate-300" />
        <p className="mt-3 text-sm font-semibold">{emptyTitle}</p>
        <p className="mt-1 text-xs text-muted-foreground">{emptyDetail}</p>
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
            <TimelineRecordRow key={record.id} record={record} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Pill tabs matching the My Leads status-tab treatment (count badge, blue inset underline). */
export function ActivityTabStrip<TValue extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ value: TValue; label: string; count?: number }>;
  active: TValue;
  onChange: (value: TValue) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Activity kind"
      className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.value)}
            style={isActive ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
            className={cn(
              'relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset',
              isActive ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700',
            )}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' && (
              <span
                className={cn(
                  'grid min-w-5 place-items-center rounded px-1 py-0.5 text-[10px] leading-none',
                  isActive ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
