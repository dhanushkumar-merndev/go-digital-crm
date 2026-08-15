'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CircleAlert } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  useTenantRealtimeInvalidation,
  type TenantRealtimeResource,
} from '@/lib/realtime/use-realtime-invalidation';
import { fetchTenantDashboard, type TenantDashboardResult } from './tenant-dashboard-api';

const tenantDashboardKey = ['tenant-performance-dashboard'] as const;

function formatInr(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function dashboardMetrics(data: TenantDashboardResult, role: RoleKey): Metric[] {
  const { capabilities, kpis } = data;
  if (capabilities.operations && !capabilities.leads)
    return [
      { label: 'Open cases', value: String(kpis.open_cases), helper: 'Current authorized scope' },
      { label: 'Overdue', value: String(kpis.overdue_cases), helper: 'Past due action time' },
      { label: 'Due today', value: String(kpis.cases_due_today), helper: 'Needs action today' },
      {
        label: 'Completed this month',
        value: String(kpis.cases_completed_month),
        helper: 'Terminal workflows',
      },
    ];
  if (role === 'business-owner' || role === 'client-admin' || role === 'system-administrator') {
    const executive: Metric[] = [];
    if (capabilities.leads)
      executive.push({ label: 'Open leads', value: String(kpis.open_leads), helper: 'In scope' });
    if (capabilities.bookings) {
      executive.push({
        label: 'Bookings this month',
        value: String(kpis.bookings_month),
        helper: 'Non-cancelled',
      });
      executive.push({
        label: 'Booking value',
        value: formatInr(kpis.booking_value_month),
        helper: 'This month',
      });
    }
    if (capabilities.operations)
      executive.push({
        label: 'Open cases',
        value: String(kpis.open_cases),
        helper: 'All departments',
      });
    if (capabilities.inventory)
      executive.push({
        label: 'Available stock',
        value: String(kpis.available_stock),
        helper: 'Authorized branches',
      });
    return executive.slice(0, 4);
  }
  const metrics: Metric[] = [];
  if (capabilities.leads) {
    metrics.push(
      { label: 'New leads today', value: String(kpis.new_leads_today), helper: 'Created today' },
      { label: 'Open leads', value: String(kpis.open_leads), helper: 'Excludes lost leads' },
      { label: 'Due follow-ups', value: String(kpis.followups_due_today), helper: 'Today' },
      {
        label: 'Overdue follow-ups',
        value: String(kpis.followups_overdue),
        helper: 'Needs attention',
      },
    );
  }
  if (!metrics.length && capabilities.work)
    metrics.push(
      { label: 'Due follow-ups', value: String(kpis.followups_due_today), helper: 'Today' },
      {
        label: 'Overdue follow-ups',
        value: String(kpis.followups_overdue),
        helper: 'Needs attention',
      },
      {
        label: 'Appointments today',
        value: String(kpis.appointments_today),
        helper: 'Scheduled or confirmed',
      },
    );
  if (!metrics.length && capabilities.calls)
    metrics.push({
      label: 'Calls today',
      value: String(kpis.calls_today),
      helper: 'Current scope',
    });
  if (capabilities.test_drives)
    metrics.push({
      label: 'Test drives today',
      value: String(kpis.test_drives_today),
      helper: 'Scheduled and active',
    });
  if (capabilities.bookings)
    metrics.push({
      label: 'Bookings this month',
      value: String(kpis.bookings_month),
      helper: formatInr(kpis.booking_value_month),
    });
  return metrics.slice(0, 4);
}

function subscriptions(data: TenantDashboardResult | undefined) {
  if (!data) return [];
  const resources: TenantRealtimeResource[] = [];
  if (data.capabilities.leads) resources.push('leads');
  if (data.capabilities.work) resources.push('work');
  if (data.capabilities.calls) resources.push('communications');
  if (data.capabilities.bookings) resources.push('sales');
  if (data.capabilities.inventory) resources.push('inventory');
  if (data.capabilities.test_drives && !resources.includes('work')) resources.push('work');
  if (data.capabilities.operations) resources.push('operations');
  return resources.map((resource) => ({ resource, queryKeys: [tenantDashboardKey] }));
}

export function TenantDashboard({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  const dashboard = useQuery({
    queryKey: tenantDashboardKey,
    queryFn: ({ signal }) => fetchTenantDashboard(signal),
  });
  const realtimeSubscriptions = useMemo(() => subscriptions(dashboard.data), [dashboard.data]);
  useTenantRealtimeInvalidation(dashboard.data?.organization_id, realtimeSubscriptions);

  if (dashboard.isPending) return <PageSkeleton />;
  if (dashboard.isError || !dashboard.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Dashboard data is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              A valid tenant role, data scope and at least one module permission are required.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const data = dashboard.data;
  const showActivity =
    data.capabilities.leads || data.capabilities.calls || data.capabilities.bookings;
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={dashboardMetrics(data, role)} />

      {(showActivity || data.pipeline.length > 0) && (
        <div className="grid gap-6 xl:grid-cols-12">
          {showActivity && (
            <Card className="shadow-none xl:col-span-7">
              <CardHeader>
                <CardTitle className="text-base">Activity trend</CardTitle>
                <CardDescription>
                  Authorized activity over the last {data.days} days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EChart
                  kind="line"
                  data={data.activity}
                  seriesNames={[data.activity_primary, data.activity_secondary]}
                />
              </CardContent>
            </Card>
          )}
          {data.pipeline.length > 0 && (
            <Card className={`shadow-none ${showActivity ? 'xl:col-span-5' : 'xl:col-span-12'}`}>
              <CardHeader>
                <CardTitle className="text-base">Lead pipeline</CardTitle>
                <CardDescription>Current lifecycle distribution in your data scope</CardDescription>
              </CardHeader>
              <CardContent>
                <EChart kind="funnel" data={data.pipeline} />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {data.capabilities.work && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Requires attention</CardTitle>
            <CardDescription>Overdue customer commitments in your authorized scope</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {data.attention.length ? (
              data.attention.map((item) => {
                const Icon = item.severity === 'HIGH' ? CircleAlert : CalendarClock;
                return (
                  <div key={item.id} className="flex items-start gap-3 rounded-lg border p-4">
                    <span
                      className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                        item.severity === 'HIGH'
                          ? 'bg-red-50 text-red-600'
                          : 'bg-amber-50 text-amber-600'
                      }`}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{item.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.detail}
                      </span>
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground md:col-span-2">
                No overdue customer commitment currently requires attention.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
