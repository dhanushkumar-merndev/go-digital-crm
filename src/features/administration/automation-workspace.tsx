'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CircleAlert, CopyPlus, Play, Plus, Search, ToggleLeft } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  createAutomationRule,
  fetchAutomationWorkspace,
  setAutomationRuleEnabled,
  type AutomationRule,
  type AutomationWorkspaceQuery,
} from './automation-workspace-api';

const eventOptions = [
  ['LEAD_CREATED', 'New lead created'],
  ['LEAD_UPDATED', 'Lead updated'],
  ['TEST_DRIVE_COMPLETED', 'Test drive completed'],
  ['BOOKING_CONFIRMED', 'Booking confirmed'],
  ['QUOTATION_SENT', 'Quotation sent'],
  ['DELIVERY_COMPLETED', 'Delivery completed'],
] as const;
const actionOptions = [
  ['ASSIGN_LEAD', 'Assign lead'],
  ['CREATE_FOLLOWUP', 'Create follow-up'],
  ['CREATE_TASK', 'Create task'],
  ['SEND_ALERT', 'Send internal alert'],
  ['SEND_REMINDER', 'Send customer reminder'],
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function CreateAutomationDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: createAutomationRule,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['automation-workspace'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create automation</DialogTitle>
          <DialogDescription>
            Save an auditable CRM rule. It is enabled only when you explicitly choose Active.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            create.mutate({
              name: String(values.get('name') ?? '').trim(),
              eventType: String(values.get('eventType') ?? ''),
              conditionSummary: String(values.get('condition') ?? '').trim(),
              actionType: String(values.get('actionType') ?? ''),
              actionSummary: String(values.get('action') ?? '').trim(),
              enabled: values.get('enabled') === 'ACTIVE',
              requestId: globalThis.crypto.randomUUID(),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Rule name
            <Input
              name="name"
              required
              minLength={2}
              maxLength={120}
              placeholder="Follow up after a test drive"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Trigger
              <Select name="eventType" defaultValue="TEST_DRIVE_COMPLETED">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eventOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Action
              <Select name="actionType" defaultValue="CREATE_FOLLOWUP">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {actionOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Condition <span className="font-normal text-muted-foreground">(optional)</span>
            <Input
              name="condition"
              maxLength={500}
              placeholder="For example: lead source is Instagram"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Action detail
            <Textarea
              name="action"
              required
              maxLength={500}
              placeholder="Create a follow-up for 24 hours after completion"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Initial status
            <Select name="enabled" defaultValue="DRAFT">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DRAFT">Draft — save without enabling</SelectItem>
                <SelectItem value="ACTIVE">Active — enable immediately</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {create.isError && (
            <Alert>
              <AlertTitle>Automation was not saved</AlertTitle>
              <AlertDescription>
                Check the fields and your administrator permission, then retry.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              <CopyPlus className="size-4" />
              {create.isPending ? 'Saving…' : 'Save automation'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AutomationTable({
  records,
  role,
  onToggle,
  pendingId,
}: {
  records: AutomationRule[];
  role: string;
  onToggle: (rule: AutomationRule) => void;
  pendingId: string | null;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b p-4">
        <CardTitle className="text-base">Automation rules</CardTitle>
        <CardDescription>
          Rules execute only through the server-side automation dispatcher.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Success</TableHead>
              <TableHead>Last updated</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.length ? (
              records.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Link
                      href={`/${role}/automation-rules/${rule.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {rule.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {rule.execution_count.toLocaleString()} executions · {rule.created_by_name}
                    </p>
                  </TableCell>
                  <TableCell>
                    {eventOptions.find(([value]) => value === rule.event_type)?.[1] ??
                      rule.event_type}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">{rule.condition_summary}</TableCell>
                  <TableCell className="max-w-52 truncate">{rule.action_summary}</TableCell>
                  <TableCell>
                    <StatusBadge value={rule.enabled ? 'Active' : 'Draft'} />
                  </TableCell>
                  <TableCell>{rule.execution_count ? `${rule.success_rate}%` : '—'}</TableCell>
                  <TableCell>{formatDate(rule.updated_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pendingId === rule.id}
                      onClick={() => onToggle(rule)}
                    >
                      <ToggleLeft className="size-3.5" />
                      {rule.enabled ? 'Pause' : 'Enable'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                  No automation rules match this view.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function AutomationWorkspace({ spec }: { spec: PageSpec }) {
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<AutomationWorkspaceQuery['status']>('ALL');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const search = useDebouncedValue(searchInput, 300);
  const query = useQuery({
    queryKey: ['automation-workspace', page, search, status],
    queryFn: () => fetchAutomationWorkspace({ page, pageSize: 25, search, status }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setAutomationRuleEnabled(id, enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: ['automation-workspace'] }),
  });
  const metrics = useMemo<Metric[]>(
    () =>
      query.data
        ? [
            {
              label: 'Total rules',
              value: query.data.kpis.total_rules.toLocaleString(),
              icon: Activity,
            },
            {
              label: 'Active rules',
              value: query.data.kpis.active_rules.toLocaleString(),
              icon: Play,
            },
            {
              label: 'Draft rules',
              value: query.data.kpis.draft_rules.toLocaleString(),
              icon: CopyPlus,
            },
            {
              label: 'Failed runs today',
              value: query.data.kpis.failed_runs_today.toLocaleString(),
              icon: CircleAlert,
              trend: query.data.kpis.failed_runs_today ? 'down' : 'neutral',
            },
          ]
        : [],
    [query.data],
  );
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert>
          <AlertTitle>Automation rules are unavailable</AlertTitle>
          <AlertDescription>
            Confirm administrator access and deploy the automation workspace migration.
          </AlertDescription>
        </Alert>
      </div>
    );
  const summary = query.data.execution_summary;
  const totalRuns = summary.succeeded + summary.failed + summary.pending;
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          Create automation
        </Button>
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              placeholder="Search automation rules"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as AutomationWorkspaceQuery['status']);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All status</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <AutomationTable
          records={query.data.records}
          role="system-administrator"
          pendingId={toggle.isPending ? (toggle.variables?.id ?? null) : null}
          onToggle={(rule) => toggle.mutate({ id: rule.id, enabled: !rule.enabled })}
        />
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Execution summary</CardTitle>
            <CardDescription>Last 30 days of recorded server runs</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="donut"
              className="h-56"
              data={[
                { name: 'Succeeded', value: summary.succeeded },
                { name: 'Failed', value: summary.failed },
                { name: 'Pending', value: summary.pending },
              ]}
            />
            <div className="mt-3 space-y-2 text-sm">
              <p className="flex justify-between">
                <span className="text-muted-foreground">Recorded runs</span>
                <span className="font-medium">{totalRuns.toLocaleString()}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-muted-foreground">Succeeded</span>
                <span className="font-medium">{summary.succeeded.toLocaleString()}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-muted-foreground">Failed</span>
                <span className="font-medium">{summary.failed.toLocaleString()}</span>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      {toggle.isError && (
        <Alert>
          <AlertTitle>Rule status was not changed</AlertTitle>
          <AlertDescription>
            Refresh the workspace and verify your permission before retrying.
          </AlertDescription>
        </Alert>
      )}
      {open && <CreateAutomationDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
