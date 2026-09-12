'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, ClipboardList, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { PageHeader } from '@/components/shared/page-header';
import { TenantDashboardSkeleton } from '@/components/skeletons/dashboard-skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  businessOperationsKey,
  businessSalesOverviewKey,
  businessShowroomKey,
  fetchBusinessOperationsOverview,
  fetchBusinessSalesOverview,
  fetchBusinessShowroomPerformance,
} from './business-overview-api';

const windowChoices = [7, 30, 90] as const;

function Unavailable({ what }: { what: string }) {
  return (
    <Alert>
      <AlertTitle>{what} is unavailable</AlertTitle>
      <AlertDescription>
        Confirm your assigned data scope, then refresh. If this persists, the overview migration may
        not be deployed.
      </AlertDescription>
    </Alert>
  );
}

/** A proportion bar. The number stays readable; the bar carries the comparison. */
function ShareBar({ value, of }: { value: number; of: number }) {
  const share = of > 0 ? Math.round((value / of) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-blue-600" style={{ width: `${share}%` }} />
      </div>
      <span className="w-9 text-xs tabular-nums text-muted-foreground">{share}%</span>
    </div>
  );
}

function WindowPicker({ days, onChange }: { days: number; onChange: (value: number) => void }) {
  return (
    <Select value={String(days)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger className="w-40" aria-label="Reporting window">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {windowChoices.map((choice) => (
          <SelectItem key={choice} value={String(choice)}>
            Last {choice} days
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BusinessSalesOverview({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [days, setDays] = useState<number>(30);
  const overview = useQuery({
    queryKey: businessSalesOverviewKey(workspaceQueryScope(session), days),
    queryFn: ({ signal }) => fetchBusinessSalesOverview(days, signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: 'leads',
      queryKeys: [['business-sales-overview', ...workspaceQueryScope(session)]],
    },
  ]);
  if (overview.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (overview.isError) return <Unavailable what="Sales overview" />;
  const data = overview.data;
  const totals = data?.totals;
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <WindowPicker days={days} onChange={setDays} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Leads created', totals?.leads ?? 0],
          ['Moved to sales', totals?.transferred ?? 0],
          ['Lost', totals?.lost ?? 0],
        ].map(([label, value]) => (
          <Card key={String(label)} className="shadow-none">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="size-4 text-blue-600" /> Pipeline by stage
            </CardTitle>
            <CardDescription>Where leads created in this window currently sit.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.pipeline.length ? (
                  data.pipeline.map((row) => (
                    <TableRow key={row.stage}>
                      <TableCell>
                        <StatusBadge value={row.stage} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <ShareBar value={row.leads} of={totals?.leads ?? 0} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No leads created in this window.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Lead sources</CardTitle>
            <CardDescription>Which channels produced this window&apos;s leads.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.sources.length ? (
                  data.sources.map((row) => (
                    <TableRow key={row.source}>
                      <TableCell className="font-medium">{row.source}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <ShareBar value={row.leads} of={totals?.leads ?? 0} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                      No sources to report yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Consultant activity</CardTitle>
          <CardDescription>
            Top ten by lead volume, with how many each moved through to sales.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consultant</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Moved to sales</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.consultants.length ? (
                data.consultants.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.won}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <ShareBar value={row.won} of={row.leads} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No consultant activity in this window.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function BusinessShowroomPerformance({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [days, setDays] = useState<number>(30);
  const overview = useQuery({
    queryKey: businessShowroomKey(workspaceQueryScope(session), days),
    queryFn: ({ signal }) => fetchBusinessShowroomPerformance(days, signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'work', 'sales'] as const).map((resource) => ({
      resource,
      queryKeys: [['business-showroom-performance', ...workspaceQueryScope(session)]],
    })),
  );
  if (overview.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (overview.isError) return <Unavailable what="Showroom performance" />;
  const branches = overview.data?.branches ?? [];
  const busiest = Math.max(1, ...branches.map((branch) => branch.leads));
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <WindowPicker days={days} onChange={setDays} />
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4 text-blue-600" /> Branch comparison
          </CardTitle>
          <CardDescription>
            Every branch in your scope, including any with no activity this window.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Test drives</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Moved to sales</TableHead>
                <TableHead className="text-right">Volume</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.length ? (
                branches.map((branch) => (
                  <TableRow key={branch.branch_id}>
                    <TableCell className="font-medium">{branch.branch}</TableCell>
                    <TableCell className="text-right tabular-nums">{branch.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{branch.test_drives}</TableCell>
                    <TableCell className="text-right tabular-nums">{branch.bookings}</TableCell>
                    <TableCell className="text-right tabular-nums">{branch.transferred}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <ShareBar value={branch.leads} of={busiest} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No branches are in your assigned scope.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function BusinessOperationsOverview({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const overview = useQuery({
    queryKey: [...businessOperationsKey, ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchBusinessOperationsOverview(signal),
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: 'operations',
      queryKeys: [[...businessOperationsKey, ...workspaceQueryScope(session)]],
    },
  ]);
  if (overview.isPending) return <TenantDashboardSkeleton role="business-owner" />;
  if (overview.isError) return <Unavailable what="Operations overview" />;
  const departments = overview.data?.departments ?? [];
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {departments.map((department) => (
          <Card key={department.department} className="shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <ClipboardList className="size-4 text-blue-600" /> {department.department}
                </span>
                <span
                  className={
                    department.open
                      ? 'text-2xl font-bold tabular-nums text-orange-600'
                      : 'text-2xl font-bold tabular-nums text-muted-foreground'
                  }
                >
                  {department.open}
                </span>
              </CardTitle>
              <CardDescription>
                {department.open} open of {department.total} total
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {department.statuses.length ? (
                department.statuses.map((status) => (
                  <div
                    key={status.status}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <StatusBadge value={status.status} />
                    <span className="tabular-nums text-muted-foreground">{status.count}</span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No cases on this desk.</p>
              )}
            </CardContent>
          </Card>
        ))}
        {!departments.length && (
          <Card className="shadow-none md:col-span-2 xl:col-span-3">
            <CardContent className="p-10 text-center text-muted-foreground">
              No operational cases in your assigned scope.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
