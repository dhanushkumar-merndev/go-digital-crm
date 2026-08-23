'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Blocks, Building2, CalendarDays, CarFront, UsersRound } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageSkeleton } from '@/components/shared/page-skeleton';
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
import { fetchPlatformDealershipDetail } from './dealership-detail-api';

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function DealershipDetailWorkspace({ organizationId }: { organizationId: string }) {
  const query = useQuery({
    queryKey: ['platform-dealership-detail', organizationId],
    queryFn: ({ signal }) => fetchPlatformDealershipDetail(organizationId, signal),
    staleTime: 60_000,
  });

  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <p className="font-semibold">Dealership detail is unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm Super Admin MFA access and that the dealership still exists.
          </p>
          <Button asChild className="mt-5" variant="outline">
            <Link href="/super-admin/dealerships">Return to dealerships</Link>
          </Button>
        </CardContent>
      </Card>
    );

  const { organization, kpis } = query.data;
  const metrics: Metric[] = [
    { label: 'Active branches', value: kpis.branches.toLocaleString(), icon: Building2 },
    { label: 'Active users', value: kpis.users.toLocaleString(), icon: UsersRound },
    { label: 'Leads this week', value: kpis.leads_this_week.toLocaleString(), icon: UsersRound },
    {
      label: 'Bookings this week',
      value: kpis.bookings_this_week.toLocaleString(),
      icon: CarFront,
    },
    { label: 'Enabled modules', value: kpis.enabled_modules.toLocaleString(), icon: Blocks },
  ];

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Link className="hover:text-primary" href="/super-admin/dealerships">
              Dealerships
            </Link>
            <span>›</span>
            <span>{organization.name}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">
              {organization.name}
            </h1>
            <Badge variant={organization.status === 'ACTIVE' ? 'success' : 'secondary'}>
              {organization.status.replaceAll('_', ' ')}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {organization.legal_name ?? organization.slug} · Created{' '}
            {dateTime(organization.created_at)}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/super-admin/dealerships">
            <ArrowLeft className="size-4" /> Back to list
          </Link>
        </Button>
      </div>

      <Card className="shadow-none">
        <CardContent className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          <Detail label="Dealership ID" value={organization.id} monospace />
          <Detail label="GST number" value={organization.gst_number ?? 'Not recorded'} />
          <Detail label="Business Owner" value={organization.owner_name ?? 'Not assigned'} />
          <Detail
            label="Owner contact"
            value={organization.owner_email ?? organization.owner_phone ?? 'Not recorded'}
          />
        </CardContent>
      </Card>

      <KpiGrid metrics={metrics} className="xl:grid-cols-5" />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Weekly CRM activity</CardTitle>
            <CardDescription>
              Recorded lead and booking activity for the last seven days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={query.data.daily.map((item) => ({
                name: item.name,
                value: item.leads,
                secondary: item.bookings,
              }))}
              className="h-72"
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Lead sources</CardTitle>
            <CardDescription>New CRM leads this week by recorded source.</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart kind="donut" data={query.data.lead_sources} className="h-72" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Branch summary</CardTitle>
            <CardDescription>Active branches and scope-neutral operational counts.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead className="text-right">Leads · 7 days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.branches.map((branch) => (
                  <TableRow key={branch.id}>
                    <TableCell className="font-medium">{branch.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {branch.code}
                    </TableCell>
                    <TableCell className="text-right">{branch.users.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      {branch.leads_this_week.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {!query.data.branches.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No active branches are configured.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="overflow-hidden shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>
              Sanitized tenant audit events; credentials and payloads remain hidden.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-0 p-0">
            {query.data.recent_activity.map((event) => (
              <div key={event.id} className="border-b px-5 py-3 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{event.action}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {event.summary ?? event.resource_type}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateTime(event.created_at)}
                  </span>
                </div>
              </div>
            ))}
            {!query.data.recent_activity.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">No recent activity.</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={
          monospace
            ? 'mt-1 truncate font-mono text-xs text-foreground'
            : 'mt-1 truncate text-sm font-semibold'
        }
      >
        {value}
      </p>
    </div>
  );
}
