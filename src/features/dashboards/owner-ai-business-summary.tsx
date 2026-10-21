'use client';

import type { PageSpec } from '@/lib/domain';
import { PageHeader } from '@/components/shared/page-header';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, FileText, WalletCards } from 'lucide-react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SectionCard } from '@/components/shared/section-card';
import { OwnerAiBusinessSummarySkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchOwnerAiBusinessSummary } from './owner-ai-business-summary-api';

function formatDay(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

/** Ledger feature keys are stored as codes; show them as words. */
function featureLabel(key: string) {
  const words = key.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

/**
 * The Business Owner has two pages over this data, so they split it: SUMMARY is
 * what AI produced, CREDITS is what it cost. Client Admin has one page (FULL).
 */
export type OwnerAiView = 'FULL' | 'SUMMARY' | 'CREDITS';

export function OwnerAiBusinessSummaryWorkspace({
  spec,
  heading,
  view = 'FULL',
}: {
  spec: PageSpec;
  heading?: string;
  view?: OwnerAiView;
}) {
  const session = useWorkspaceSession();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const query = useQuery({
    queryKey: ['owner-ai-business-summary', ...workspaceQueryScope(session), days],
    queryFn: ({ signal }) => fetchOwnerAiBusinessSummary(days, signal),
    staleTime: 60_000,
  });
  if (query.isPending) return <OwnerAiBusinessSummarySkeleton />;
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
  const showCredits = view !== 'SUMMARY';
  const showOutput = view !== 'CREDITS';
  const metrics = [
    ...(showCredits
      ? [
          {
            label: 'AI credits used',
            value: kpis.credits_used.toLocaleString('en-IN'),
            helper: `Last ${days} days`,
            icon: WalletCards,
            tone: 'bg-violet-50 text-violet-600',
          },
          {
            label: 'AI credits remaining',
            value: kpis.credits_remaining.toLocaleString('en-IN'),
            helper: 'Current balance',
            icon: WalletCards,
            tone: 'bg-emerald-50 text-emerald-600',
          },
        ]
      : []),
    ...(showOutput
      ? [
          {
            label: 'Call summaries',
            value: kpis.summaries_generated.toLocaleString('en-IN'),
            helper: 'Generated in period',
            icon: FileText,
            tone: 'bg-blue-50 text-blue-600',
          },
          {
            label: 'Completed extractions',
            value: kpis.extractions_completed.toLocaleString('en-IN'),
            helper: 'Field suggestions produced',
            icon: CheckCircle2,
            tone: 'bg-cyan-50 text-cyan-600',
          },
          {
            label: 'Reviews pending',
            value: kpis.reviews_pending.toLocaleString('en-IN'),
            helper: 'Awaiting a person',
            icon: CircleAlert,
            tone: 'bg-amber-50 text-amber-600',
          },
        ]
      : []),
  ];

  const title = heading ?? spec.title;
  const description =
    view === 'CREDITS'
      ? 'AI credits consumed and remaining, from the immutable credit ledger. Allocations remain with the platform Super Admin.'
      : view === 'SUMMARY'
        ? 'Call summaries, field extractions and reviews AI produced in your organization. Nothing here is generated on the fly.'
        : 'Tenant AI-credit consumption and recorded call-processing activity. Credit allocations remain platform Super Admin only.';

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={spec}
        title={title}
        description={description}
        actions={
          <>
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
          </>
        }
      />
      <KpiGrid metrics={metrics} />
      {showCredits ? (
        <div className="grid gap-4 xl:grid-cols-12">
          <SectionCard
            title="AI credit usage over time"
            description="Consumption entries recorded in the immutable credit ledger."
            className="xl:col-span-7"
          >
            <EChart
              kind="line"
              data={query.data.daily_usage.map((point) => ({
                name: formatDay(point.date),
                value: point.credits_used,
              }))}
              seriesNames={['Credits used', '']}
            />
          </SectionCard>
          <SectionCard
            title="Usage by feature"
            description="Only features with recorded consumption are shown."
            className="xl:col-span-5"
          >
            <EChart
              kind="donut"
              data={query.data.feature_usage.map((feature) => ({
                ...feature,
                name: featureLabel(feature.name),
              }))}
            />
          </SectionCard>
        </div>
      ) : null}
      {showOutput ? (
        <SectionCard
          title="Recent AI call summaries"
          description="Stored outputs only; customer data remains within your authorized organization scope."
          contentClassName="space-y-3 p-4"
        >
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
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-heading-soft">
                  {summary.summary}
                </p>
              </article>
            ))
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No AI call summaries have been recorded in this organization yet.
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
