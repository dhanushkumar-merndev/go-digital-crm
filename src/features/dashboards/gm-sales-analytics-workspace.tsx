'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CarFront, FileText, PhoneCall, Trophy, UsersRound } from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { GmSalesAnalyticsSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
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
import type { Metric } from '@/lib/domain';
import { fetchGmSalesAnalytics } from './gm-sales-analytics-api';

export type GmSalesAnalyticsView =
  'sales-performance' | 'showroom-comparison' | 'consultant-ranking' | 'model-performance';

const copy: Record<GmSalesAnalyticsView, { title: string; description: string }> = {
  'sales-performance': {
    title: 'Sales Performance',
    description: 'Organization-wide sales activity within your authorized branch scope.',
  },
  'showroom-comparison': {
    title: 'Showroom Comparison',
    description: 'Compare branch activity using only live, scope-authorized CRM records.',
  },
  'consultant-ranking': {
    title: 'Sales Consultant Ranking',
    description: 'Rank active sales consultants by current-period CRM outcomes.',
  },
  'model-performance': {
    title: 'Model Performance',
    description: 'Interested-model demand in your authorized sales lead scope.',
  },
};

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function GmSalesAnalyticsWorkspace({ view }: { view: GmSalesAnalyticsView }) {
  const session = useWorkspaceSession();
  const [days, setDays] = useState<7 | 14 | 30>(30);
  const query = useQuery({
    // Every GM analytics route consumes the same bounded aggregate payload.
    // Keep one scope-aware cache entry so changing views does not repeat the RPC.
    queryKey: ['gm-sales-analytics', ...workspaceQueryScope(session), days],
    queryFn: ({ signal }) => fetchGmSalesAnalytics(days, signal),
    staleTime: 60_000,
  });
  const heading = copy[view];
  if (query.isPending) return <GmSalesAnalyticsSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <h1 className="font-semibold">GM analytics is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your GM Sales Executive role, branch scope, and the analytics migration.
          </p>
        </CardContent>
      </Card>
    );
  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Leads',
      value: data.kpis.leads.toLocaleString(),
      helper: `Last ${data.days} days`,
      icon: UsersRound,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Calls',
      value: data.kpis.calls.toLocaleString(),
      helper: 'Authorized calls',
      icon: PhoneCall,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Test drives',
      value: data.kpis.test_drives.toLocaleString(),
      helper: 'Scheduled drives',
      icon: CarFront,
      tone: 'bg-cyan-50 text-cyan-600',
    },
    {
      label: 'Quotations',
      value: data.kpis.quotations.toLocaleString(),
      helper: 'Created in period',
      icon: FileText,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Bookings',
      value: data.kpis.bookings.toLocaleString(),
      helper: `${data.kpis.conversion.toFixed(1)}% lead conversion`,
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
  ];

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">GM Sales Executive › Analytics</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{heading.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{heading.description}</p>
        </div>
        <Select
          value={String(days)}
          onValueChange={(value) => setDays(Number(value) as 7 | 14 | 30)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-5" />
      {view === 'sales-performance' ? <PerformanceContent data={data} /> : null}
      {view === 'showroom-comparison' ? <BranchTable data={data} /> : null}
      {view === 'consultant-ranking' ? <ConsultantTable data={data} /> : null}
      {view === 'model-performance' ? <ModelTable data={data} /> : null}
    </div>
  );
}

function PerformanceContent({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
  return (
    <div className="grid gap-5 xl:grid-cols-12">
      <Card className="shadow-none xl:col-span-7">
        <CardHeader>
          <CardTitle className="text-base">Daily trend</CardTitle>
          <CardDescription>Leads and bookings, by day</CardDescription>
        </CardHeader>
        <CardContent>
          <EChart
            kind="line"
            data={data.daily.map((row) => ({
              name: row.name,
              value: row.leads,
              secondary: row.bookings,
            }))}
            seriesNames={['Leads', 'Bookings']}
            className="h-[320px]"
          />
        </CardContent>
      </Card>
      <Card className="shadow-none xl:col-span-5">
        <CardHeader>
          <CardTitle className="text-base">Sales funnel volumes</CardTitle>
          <CardDescription>Activity counts in the selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <EChart
            kind="funnel"
            data={[
              { name: 'Leads', value: data.kpis.leads },
              { name: 'Calls', value: data.kpis.calls },
              { name: 'Test drives', value: data.kpis.test_drives },
              { name: 'Quotations', value: data.kpis.quotations },
              { name: 'Bookings', value: data.kpis.bookings },
            ]}
            className="h-[320px]"
          />
        </CardContent>
      </Card>
      <div className="xl:col-span-12">
        <BranchTable data={data} compact />
      </div>
    </div>
  );
}

function BranchTable({
  data,
  compact = false,
}: {
  data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>>;
  compact?: boolean;
}) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="size-4 text-blue-600" /> Branch performance
        </CardTitle>
        <CardDescription>
          Only branches in the GM&apos;s current authorized scope are included.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Showroom</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Test drives</TableHead>
              <TableHead>Quotations</TableHead>
              <TableHead>Bookings</TableHead>
              <TableHead>Conversion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.branches.map((branch) => (
              <TableRow key={branch.id}>
                <TableCell className="font-medium">{branch.name}</TableCell>
                <TableCell>{branch.leads}</TableCell>
                <TableCell>{branch.calls}</TableCell>
                <TableCell>{branch.test_drives}</TableCell>
                <TableCell>{branch.quotations}</TableCell>
                <TableCell>{branch.bookings}</TableCell>
                <TableCell>
                  <Badge variant={branch.conversion >= 10 ? 'success' : 'outline'}>
                    {branch.conversion.toFixed(1)}%
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {!data.branches.length ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No accessible active branches are available.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
      {compact ? null : (
        <CardContent className="border-t py-3 text-xs text-muted-foreground">
          Sorted by bookings, then leads. This does not infer or display unavailable revenue/target
          values.
        </CardContent>
      )}
    </Card>
  );
}

function ConsultantTable({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Consultant leaderboard</CardTitle>
        <CardDescription>
          Ranked by bookings, quotations, calls, then consultant name.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Consultant</TableHead>
              <TableHead>Showroom</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Drives</TableHead>
              <TableHead>Quotes</TableHead>
              <TableHead>Bookings</TableHead>
              <TableHead>Conversion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.consultants.map((member, index) => (
              <TableRow key={member.user_id}>
                <TableCell className="font-semibold">{index + 1}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="grid size-8 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                      {initials(member.full_name)}
                    </span>
                    {member.full_name}
                  </span>
                </TableCell>
                <TableCell>{member.branch_name}</TableCell>
                <TableCell>{member.leads}</TableCell>
                <TableCell>{member.calls}</TableCell>
                <TableCell>{member.test_drives}</TableCell>
                <TableCell>{member.quotations}</TableCell>
                <TableCell>{member.bookings}</TableCell>
                <TableCell>
                  <Badge variant={member.conversion >= 10 ? 'success' : 'outline'}>
                    {member.conversion.toFixed(1)}%
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {!data.consultants.length ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  No active consultants are visible in your current scope.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ModelTable({ data }: { data: Awaited<ReturnType<typeof fetchGmSalesAnalytics>> }) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Interested-model demand</CardTitle>
        <CardDescription>
          Derived from live lead interest fields; it is not inventory availability.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <EChart
          kind="bar"
          data={data.models.slice(0, 12).map((row) => ({ name: row.name, value: row.leads }))}
          className="h-[360px]"
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Leads</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.models.map((model) => (
              <TableRow key={model.name}>
                <TableCell className="font-medium">{model.name}</TableCell>
                <TableCell className="text-right">{model.leads}</TableCell>
              </TableRow>
            ))}
            {!data.models.length ? (
              <TableRow>
                <TableCell colSpan={2} className="py-10 text-center text-sm text-muted-foreground">
                  No interested-model values are available in this period.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
