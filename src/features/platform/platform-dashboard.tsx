'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, Clock3 } from 'lucide-react';
import Link from 'next/link';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Metric, PageSpec } from '@/lib/domain';
import { usePlatformRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchPlatformDashboard } from './platform-dashboard-api';

const platformActivitySeriesNames: [string, string] = ['New tenants', 'Onboarding submissions'];

function toMetrics(kpis: Awaited<ReturnType<typeof fetchPlatformDashboard>>['kpis']): Metric[] {
  return [
    {
      label: 'Active dealerships',
      value: kpis.active_dealerships.toLocaleString(),
      helper: 'Approved tenant access',
    },
    {
      label: 'Onboarding',
      value: kpis.onboarding.toLocaleString(),
      helper: 'Setup or review in progress',
    },
    {
      label: 'Provider attention',
      value: kpis.provider_attention.toLocaleString(),
      helper: 'Connection errors',
      trend: kpis.provider_attention ? 'down' : 'neutral',
    },
    {
      label: 'Pending support',
      value: kpis.pending_support.toLocaleString(),
      helper: 'Awaiting tenant decision',
    },
  ];
}

export function PlatformDashboard({ spec }: { spec: PageSpec }) {
  usePlatformRealtimeInvalidation([
    { resource: 'dealerships', queryKeys: [['platform-dashboard']] },
    { resource: 'onboarding', queryKeys: [['platform-dashboard']] },
    { resource: 'integrations', queryKeys: [['platform-dashboard']] },
    { resource: 'support', queryKeys: [['platform-dashboard']] },
  ]);
  const dashboard = useQuery({
    queryKey: ['platform-dashboard'],
    queryFn: fetchPlatformDashboard,
  });
  if (dashboard.isPending) return <PageSkeleton />;
  if (dashboard.isError || !dashboard.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Platform dashboard is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              A Super Admin AAL2 session and the platform dashboard migration are required.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={toMetrics(dashboard.data.kpis)} />
      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader>
            <CardTitle className="text-base">Platform activity</CardTitle>
            <CardDescription>
              New tenants and submitted onboarding reviews over 14 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={dashboard.data.activity}
              seriesNames={platformActivitySeriesNames}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none xl:col-span-5">
          <CardHeader>
            <CardTitle className="text-base">Tenant status</CardTitle>
            <CardDescription>Current non-deleted dealership distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={dashboard.data.tenant_statuses} />
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Requires attention</CardTitle>
            <CardDescription>Tenant access and onboarding decisions needing review</CardDescription>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href="/super-admin/onboarding-reviews">
              Review queue <ArrowRight className="size-4" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {dashboard.data.attention.length ? (
            dashboard.data.attention.map((item) => {
              const Icon = item.severity === 'high' ? CircleAlert : Clock3;
              return (
                <Link
                  key={`${item.organization_id}:${item.href}`}
                  href={item.href}
                  className="flex items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50"
                >
                  <span
                    className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                      item.severity === 'high'
                        ? 'bg-red-50 text-red-600'
                        : 'bg-amber-50 text-amber-600'
                    }`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{item.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                </Link>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground md:col-span-2">
              No tenant access or onboarding item currently requires attention.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
