import {
  BadgeIndianRupee,
  CarFront,
  ChevronRight,
  ClipboardCheck,
  FileWarning,
  Landmark,
  ShieldCheck,
  Stamp,
} from 'lucide-react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  operationalCaseStatuses,
  operationalCaseStatusLabel,
  type OperationalCaseDepartment,
} from './operational-case-query';
import type { OperationalCaseRecord, OperationalCaseWorkspaceResult } from './operational-case-api';

const departmentPresentation: Record<
  OperationalCaseDepartment,
  { label: string; description: string; icon: typeof Landmark; tone: string }
> = {
  FINANCE: {
    label: 'Finance operations',
    description: 'Keep applications, approvals and disbursements moving.',
    icon: Landmark,
    tone: 'bg-emerald-50 text-emerald-600',
  },
  INSURANCE: {
    label: 'Insurance operations',
    description: 'Manage quotes, acceptance and policy issuance.',
    icon: ShieldCheck,
    tone: 'bg-blue-50 text-blue-600',
  },
  RTO: {
    label: 'RTO operations',
    description: 'Keep registration and documentation milestones on track.',
    icon: Stamp,
    tone: 'bg-violet-50 text-violet-600',
  },
  EXCHANGE: {
    label: 'Exchange operations',
    description: 'Coordinate appraisal, offers and accepted exchanges.',
    icon: CarFront,
    tone: 'bg-orange-50 text-orange-600',
  },
  DELIVERY: {
    label: 'Delivery operations',
    description: 'Progress checklists, scheduling and handover.',
    icon: BadgeIndianRupee,
    tone: 'bg-cyan-50 text-cyan-600',
  },
};

function priorityScore(priority: OperationalCaseRecord['priority']) {
  return { URGENT: 4, HIGH: 3, NORMAL: 2, LOW: 1 }[priority];
}

function isDueNow(record: OperationalCaseRecord) {
  return Boolean(record.due_at && new Date(record.due_at).getTime() <= Date.now());
}

export function ConnectedOperationalOverview({
  department,
  result,
  onOpen,
}: {
  department: OperationalCaseDepartment;
  result: OperationalCaseWorkspaceResult;
  onOpen: (record: OperationalCaseRecord) => void;
}) {
  const presentation = departmentPresentation[department];
  const Icon = presentation.icon;
  const steps = operationalCaseStatuses[department].slice(0, 5);
  const priorityQueue = [...result.records]
    .filter(
      (record) =>
        ![
          'CANCELLED',
          'REJECTED',
          'DELIVERED',
          'DISBURSED',
          'POLICY_ISSUED',
          'REGISTERED',
        ].includes(record.status),
    )
    .sort((left, right) => {
      const dueDifference = Number(isDueNow(right)) - Number(isDueNow(left));
      return dueDifference || priorityScore(right.priority) - priorityScore(left.priority);
    })
    .slice(0, 4);

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <Card className="shadow-none xl:col-span-8">
        <CardHeader className="border-b px-4 py-3 sm:px-5">
          <div className="flex items-start gap-3">
            <span className={cn('grid size-9 place-items-center rounded-lg', presentation.tone)}>
              <Icon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-sm">{presentation.label}</CardTitle>
              <CardDescription>{presentation.description}</CardDescription>
            </div>
            <Badge variant="secondary" className="ml-auto shrink-0">
              {result.total} cases
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-5">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Workflow progress
          </p>
          <div className="grid gap-2 sm:grid-cols-5">
            {steps.map((step, index) => {
              const count = result.records.filter((record) => record.status === step).length;
              return (
                <div key={step} className="relative min-w-0 rounded-lg border bg-slate-50/60 p-3">
                  {index < steps.length - 1 && (
                    <ChevronRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 rounded-full border bg-white p-0.5 text-slate-400 sm:block" />
                  )}
                  <p className="truncate text-[10px] font-medium text-muted-foreground">
                    {operationalCaseStatusLabel(step)}
                  </p>
                  <p className="mt-2 text-xl font-bold tracking-tight text-[#17233d]">{count}</p>
                  <p className="text-[10px] text-muted-foreground">loaded cases</p>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">
              {result.kpis.overdue} overdue
            </span>
            <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-700">
              {result.kpis.pending_documents} need documents
            </span>
            <span className="rounded-md bg-blue-50 px-2 py-1 text-blue-700">
              {result.kpis.due_today} due today
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none xl:col-span-4">
        <CardHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <div>
            <CardTitle className="text-sm">Priority queue</CardTitle>
            <CardDescription>Live cases that need action</CardDescription>
          </div>
          <FileWarning className="size-4 text-amber-600" />
        </CardHeader>
        <CardContent className="space-y-1 p-3">
          {priorityQueue.length ? (
            priorityQueue.map((record) => (
              <button
                key={record.id}
                type="button"
                onClick={() => onOpen(record)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-slate-50"
              >
                <ClipboardCheck className="size-4 shrink-0 text-blue-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-[#17233d]">
                    {record.customer_name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {record.booking_number ?? `Case ${record.id.slice(0, 8)}`}
                  </span>
                </span>
                <StatusBadge value={record.priority} />
              </button>
            ))
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No priority cases in this view.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
