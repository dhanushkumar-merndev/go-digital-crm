'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Pause,
  Play,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { fetchAutomationRuleDetail, setAutomationRuleEnabled } from './automation-workspace-api';

function formatDate(value: string | null) {
  if (!value) return 'No executions yet';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function readable(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asText(value: unknown) {
  if (!value) return 'Not configured';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function AutomationRuleDetailWorkspace({ ruleId, role }: { ruleId: string; role: string }) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ['automation-rule-detail', ruleId],
    queryFn: ({ signal }) => fetchAutomationRuleDetail(ruleId, signal),
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setAutomationRuleEnabled(ruleId, enabled),
    onSuccess: (_, enabled) => {
      toast.add({
        type: 'success',
        title: enabled ? 'Automation enabled' : 'Automation paused',
        description: 'The server-side dispatcher will use the updated state for future events.',
      });
      client.invalidateQueries({ queryKey: ['automation-rule-detail', ruleId] });
      client.invalidateQueries({ queryKey: ['automation-workspace'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Automation could not be updated',
        description: 'Check your administrator access and retry.',
      }),
  });
  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError || !detail.data)
    return (
      <div className="p-6 text-sm text-destructive">Automation rule detail is unavailable.</div>
    );
  const { rule, statistics, runs } = detail.data;
  const action = rule.actions as { type?: string; summary?: string } | null;
  const condition = rule.conditions.summary;
  const backHref = `/${role}/automation-rules`;
  const successRate = statistics.total
    ? Math.round((statistics.succeeded / statistics.total) * 100)
    : 0;
  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Administration / Automation rules</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Automation Rule Details</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View the approved configuration and recent server-side executions.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft /> Back to rules
            </Link>
          </Button>
          <Button disabled={toggle.isPending} onClick={() => toggle.mutate(!rule.enabled)}>
            {rule.enabled ? <Pause /> : <Play />}
            {rule.enabled ? 'Pause rule' : 'Enable rule'}
          </Button>
        </div>
      </div>
      <Card className="shadow-none">
        <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold">{rule.name}</h2>
              <StatusBadge value={rule.enabled ? 'Active' : 'Draft'} />
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              This rule listens for{' '}
              <span className="font-medium text-foreground">{readable(rule.event_type)}</span> and
              applies the configured action only through the server-side automation dispatcher.
            </p>
          </div>
          <div className="grid gap-1 text-sm text-muted-foreground lg:text-right">
            <p>Created by {rule.created_by_name}</p>
            <p>Last updated {formatDate(rule.updated_at)}</p>
            <p className="font-mono text-xs">Rule ID {rule.id.slice(0, 8).toUpperCase()}</p>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_360px]">
        <div className="space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Workflow className="size-4 text-blue-600" />
                Rule flow
              </CardTitle>
              <CardDescription>
                The exact configured sequence—no client-side execution is performed.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border p-4">
                <p className="text-xs font-semibold uppercase text-muted-foreground">1. Trigger</p>
                <p className="mt-2 font-semibold">{readable(rule.event_type)}</p>
                <p className="mt-1 text-sm text-muted-foreground">When this CRM event occurs</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  2. Conditions
                </p>
                <p className="mt-2 font-semibold">{asText(condition)}</p>
                <p className="mt-1 text-sm text-muted-foreground">Applied before dispatch</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs font-semibold uppercase text-muted-foreground">3. Action</p>
                <p className="mt-2 font-semibold">{readable(action?.type ?? 'ACTION')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {action?.summary ?? 'No action detail'}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Recent execution activity</CardTitle>
              <CardDescription>Most recent 25 persisted automation runs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              {runs.length ? (
                runs.map((run, index) => (
                  <div key={run.id}>
                    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="flex items-center gap-3">
                        <Activity className="size-4 text-blue-600" />
                        <div>
                          <p className="text-sm font-medium">{readable(run.status)}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(run.started_at)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <StatusBadge value={run.status} />
                        <p className="mt-1 max-w-72 truncate text-xs text-muted-foreground">
                          {asText(run.result)}
                        </p>
                      </div>
                    </div>
                    {index < runs.length - 1 && <Separator />}
                  </div>
                ))
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No persisted execution runs yet.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Performance</CardTitle>
              <CardDescription>Actual runs in the current tenant.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="rounded-lg bg-blue-50 p-4">
                <p className="text-xl font-bold text-blue-700">
                  {statistics.total.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Total executions</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-emerald-50 p-3">
                  <p className="font-bold text-emerald-700">{statistics.succeeded}</p>
                  <p className="text-xs text-muted-foreground">Succeeded</p>
                </div>
                <div className="rounded-lg bg-red-50 p-3">
                  <p className="font-bold text-red-700">{statistics.failed}</p>
                  <p className="text-xs text-muted-foreground">Failed</p>
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium">{successRate}% success rate</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {statistics.pending} queued or running · Last run{' '}
                  {formatDate(statistics.last_execution_at)}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock3 className="size-4 text-amber-600" />
                Safeguards
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                Pausing stops future dispatches; it never deletes existing CRM records.
              </p>
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                State changes and executions remain auditable.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
