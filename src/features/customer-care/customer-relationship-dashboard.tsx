'use client';

import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  Clock3,
  MessageCircleMore,
  PhoneCall,
  Send,
  Star,
} from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import { customerCareLabel } from './customer-care-query';
import type { CustomerCareDashboard, CustomerCareRecord } from './customer-care-api';

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function formatDue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(date);
}

function scoreMetrics(summary: CustomerCareDashboard): Metric[] {
  return [
    {
      label: 'Feedback calls today',
      value: String(summary.kpis.feedback_calls_today),
      helper: 'Contacted in the current scope',
      icon: PhoneCall,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Pending feedback',
      value: String(summary.kpis.feedback_pending),
      helper: 'Awaiting customer response',
      icon: CalendarClock,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Enquiry feedback due',
      value: String(summary.kpis.enquiry_feedback_due),
      helper: 'Sales experience cases',
      icon: Send,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Test-drive feedback due',
      value: String(summary.kpis.test_drive_feedback_due),
      helper: 'Completed drives without feedback',
      icon: Star,
      tone: 'bg-indigo-50 text-indigo-600',
    },
    {
      label: 'Delivery feedback due',
      value: String(summary.kpis.delivery_feedback_due),
      helper: 'Post-delivery follow-up',
      icon: BadgeCheck,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Open complaints',
      value: String(summary.kpis.complaints_open),
      helper: 'Needs resolution',
      icon: AlertTriangle,
      tone: 'bg-red-50 text-red-600',
    },
    {
      label: 'Escalations',
      value: String(summary.kpis.escalations_open),
      helper: 'Open within your scope',
      icon: MessageCircleMore,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Review requests',
      value: String(summary.kpis.review_requests_pending),
      helper: 'Still awaiting a review',
      icon: Star,
      tone: 'bg-emerald-50 text-emerald-600',
    },
  ];
}

function ScoreCard({ summary }: { summary: CustomerCareDashboard }) {
  const score = summary.scores.satisfaction;
  const circumference = 264;
  const dash = (score / 5) * circumference;
  return (
    <Card className="shadow-none xl:col-span-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Customer experience score</CardTitle>
        <CardDescription>Ratings captured in your authorized scope</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-5 pt-2">
        <div className="relative grid size-32 shrink-0 place-items-center">
          <svg className="size-32 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="42" fill="none" stroke="#e8eef9" strokeWidth="8" />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="#2563eb"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference}`}
            />
          </svg>
          <div className="absolute text-center">
            <p className="text-2xl font-bold tracking-tight">{score.toFixed(1)}</p>
            <p className="text-[10px] text-muted-foreground">out of 5</p>
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-0.5 text-amber-500">
            {Array.from({ length: 5 }).map((_, index) => (
              <Star key={index} className="size-3.5 fill-current" />
            ))}
          </div>
          <p className="text-sm font-semibold">Customer satisfaction</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {summary.scores.ratings_received
              ? `${summary.scores.ratings_received} customer ratings received.`
              : 'No customer ratings have been received yet.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreStrip({ summary }: { summary: CustomerCareDashboard }) {
  const scores = [
    ['Positive feedback', percent(summary.scores.positive_feedback_percent)],
    ['Complaint resolution', percent(summary.scores.complaint_resolution_percent)],
    ['Review request conversion', percent(summary.scores.review_request_conversion_percent)],
    ['Average response time', `${summary.scores.average_response_hours.toFixed(1)}h`],
  ];
  return (
    <Card className="shadow-none xl:col-span-8">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Service quality at a glance</CardTitle>
        <CardDescription>Calculated from live customer-care cases and feedback</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-4">
        {scores.map(([label, value]) => (
          <div key={label} className="border-l border-slate-100 pl-4 first:border-l-0 first:pl-0">
            <p className="text-xl font-bold tracking-tight text-[#17233d]">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RatingBreakdown({ data }: { data: CustomerCareDashboard['rating_breakdown'] }) {
  const maximum = Math.max(...data.map((item) => item.value), 1);
  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Customer ratings breakdown</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        {data.map((item) => (
          <div key={item.name} className="flex items-center gap-3 text-xs">
            <span className="w-10 shrink-0 text-muted-foreground">{item.name}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-blue-600"
                style={{ width: `${(item.value / maximum) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right font-medium text-[#17233d]">{item.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AttentionPanel({
  data,
  onOpen,
}: {
  data: CustomerCareDashboard['attention'];
  onOpen: (id: string) => void;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-sm">Escalations requiring attention</CardTitle>
          <CardDescription>Open cases ordered by SLA and priority</CardDescription>
        </div>
        <Clock3 className="size-4 text-amber-600" />
      </CardHeader>
      <CardContent className="space-y-2.5 pb-4">
        {data.length ? (
          data.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onOpen(item.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left hover:bg-slate-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-[#17233d]">
                  {item.customer_name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {customerCareLabel(item.case_type)} · due {formatDue(item.sla_due_at)}
                </span>
              </span>
              <StatusBadge value={item.priority} />
            </button>
          ))
        ) : (
          <p className="py-5 text-center text-xs text-muted-foreground">No cases need attention.</p>
        )}
      </CardContent>
    </Card>
  );
}

function FeedbackQueue({
  records,
  onOpen,
}: {
  records: CustomerCareRecord[];
  onOpen: (record: CustomerCareRecord) => void;
}) {
  return (
    <Card className="overflow-hidden shadow-none xl:col-span-8">
      <CardHeader className="flex-row items-center justify-between border-b py-4">
        <div>
          <CardTitle className="text-sm">Pending feedback queue</CardTitle>
          <CardDescription>Live open cases in the selected scope</CardDescription>
        </div>
        <Badge variant="secondary">{records.length} loaded</Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Consultant</TableHead>
                <TableHead>Due date</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead className="text-right"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.slice(0, 8).map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>
                      <div className="font-medium text-[#17233d]">{record.customer_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {record.phone ?? record.case_number}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-36 truncate">{record.vehicle ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-normal">
                        {customerCareLabel(record.case_type)}
                      </Badge>
                    </TableCell>
                    <TableCell>{record.assigned_user_name ?? 'Unassigned'}</TableCell>
                    <TableCell>{formatDue(record.sla_due_at)}</TableCell>
                    <TableCell>
                      <StatusBadge value={record.priority} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => onOpen(record)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-sm text-muted-foreground">
                    No open customer-care cases in this scope.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function CustomerRelationshipDashboard({
  summary,
  records,
  onOpen,
}: {
  summary: CustomerCareDashboard;
  records: CustomerCareRecord[];
  onOpen: (record: CustomerCareRecord) => void;
}) {
  const openById = (id: string) => {
    const record = records.find((item) => item.id === id);
    if (record) onOpen(record);
  };
  return (
    <div className="space-y-5">
      <KpiGrid metrics={scoreMetrics(summary)} className="xl:grid-cols-7" />

      <div className="grid gap-5 xl:grid-cols-12">
        <ScoreCard summary={summary} />
        <ScoreStrip summary={summary} />
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Feedback stage distribution</CardTitle>
            <CardDescription>All authorized customer-care cases</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={summary.status_chart} className="h-52" />
          </CardContent>
        </Card>
        <div className="grid gap-5 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-1">
          <RatingBreakdown data={summary.rating_breakdown} />
          <AttentionPanel data={summary.attention} onOpen={openById} />
        </div>
        <Card className="shadow-none xl:col-span-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top issues reported</CardTitle>
            <CardDescription>Open and resolved customer-care cases</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="bar" data={summary.issue_breakdown} className="h-[22.6rem]" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        <FeedbackQueue records={records} onOpen={onOpen} />
        <Card className="shadow-none xl:col-span-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Review performance by consultant</CardTitle>
            <CardDescription>Ratings received and average score</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary.consultant_performance.length ? (
              summary.consultant_performance.map((item, index) => (
                <div key={item.name} className="flex items-center gap-3 text-xs">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-blue-50 font-semibold text-blue-700">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-[#17233d]">
                    {item.name}
                  </span>
                  <span className="text-muted-foreground">{item.value} ratings</span>
                  <span className="font-semibold text-amber-600">
                    {item.secondary?.toFixed(1) ?? '—'} ★
                  </span>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No ratings recorded yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
