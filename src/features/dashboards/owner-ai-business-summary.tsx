'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  FileText,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchOwnerAiBusinessSummary } from './owner-ai-business-summary-api';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

export function OwnerAiBusinessSummaryWorkspace({
  audience = 'OWNER',
  heading,
}: {
  audience?: 'OWNER' | 'CLIENT_ADMIN';
  heading?: string;
}) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const query = useQuery({
    queryKey: ['owner-ai-business-summary', days],
    queryFn: ({ signal }) => fetchOwnerAiBusinessSummary(days, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="shadow-none">
        <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
          <CircleAlert className="size-6 text-amber-600" />
          <p className="font-semibold">AI activity is unavailable</p>
          <p className="max-w-xl text-sm text-muted-foreground">
            This view requires organization-wide AI-credit viewing access.
          </p>
        </CardContent>
      </Card>
    );

  const { kpis } = query.data;
  const metrics = [
    { label: 'AI credits used', value: kpis.credits_used.toLocaleString(), icon: WalletCards },
    {
      label: 'AI credits remaining',
      value: kpis.credits_remaining.toLocaleString(),
      icon: WalletCards,
    },
    { label: 'Call summaries', value: kpis.summaries_generated.toLocaleString(), icon: FileText },
    {
      label: 'Completed extractions',
      value: kpis.extractions_completed.toLocaleString(),
      icon: CheckCircle2,
    },
    { label: 'Reviews pending', value: kpis.reviews_pending.toLocaleString(), icon: CircleAlert },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">
            {audience === 'OWNER' ? 'Executive workspace' : 'Administration'} › AI activity
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">
            {heading ?? (audience === 'OWNER' ? 'Owner AI Business Summary' : 'AI Usage & Credits')}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {audience === 'OWNER'
              ? 'Recorded AI usage, review work and call summaries in your organization. This screen does not generate unrecorded recommendations.'
              : 'Review tenant AI-credit consumption and recorded call-processing activity. Credit allocations remain platform Super Admin only.'}
          </p>
        </div>
        <Select
          value={String(days)}
          onValueChange={(value) => setDays(Number(value) as 7 | 30 | 90)}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <KpiGrid metrics={metrics} />
      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-blue-600" /> AI credit usage over time
            </CardTitle>
            <CardDescription>
              Consumption entries recorded in the immutable credit ledger.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={query.data.daily_usage.map((point) => ({
                name: point.date,
                value: point.credits_used,
              }))}
              seriesNames={['Credits used', '']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none xl:col-span-5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BrainCircuit className="size-4 text-violet-600" /> Usage by feature
            </CardTitle>
            <CardDescription>Only features with recorded consumption are shown.</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={query.data.feature_usage} />
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Recent AI call summaries</CardTitle>
          <CardDescription>
            Stored outputs only; customer data remains within your authorized organization scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {query.data.recent_summaries.length ? (
            query.data.recent_summaries.map((summary) => (
              <article key={summary.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="secondary">
                    {summary.model_reference ?? 'Recorded AI summary'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(summary.created_at)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#263550]">
                  {summary.summary}
                </p>
              </article>
            ))
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No AI call summaries have been recorded in this organization yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
