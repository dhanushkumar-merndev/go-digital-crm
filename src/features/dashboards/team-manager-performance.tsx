'use client';

import { EmptyState, ErrorState } from '@/components/shared/page-states';
import type { PageSpec } from '@/lib/domain';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { CarFront, ClipboardCheck, FileText, Target, Trophy, Users } from 'lucide-react';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { BranchPicker } from '@/components/shared/branch-picker';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import {
  AGGREGATE_REALTIME_MIN_INTERVAL_MS,
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { usePersistedQuery } from '@/lib/query/persisted-query';
import { TeamManagerPerformanceSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber, formatPercent } from '@/lib/format';
import { SectionCard } from '@/components/shared/section-card';
import { performanceRangeForLastDays } from '@/lib/performance-date-range';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Metric } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { funnelNarrows } from './sales-consultant-performance';
import { SalesHandoffReport } from './sales-handoff-report';
import {
  fetchTeamManagerPerformance,
  isTelecallerMember,
  teamMemberRole,
  teamPerformanceSchema,
} from './team-manager-performance-api';

function formatDuration(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(
    Math.floor((seconds % 3600) / 60),
  ).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

/** TEAM: the managed teams (Team Performance). SHOWROOM: every team in the Sales Manager's branches. */
type PerformancePreset = 'TEAM' | 'SHOWROOM';

export function TeamManagerPerformance({
  spec,
  showHandoffs = false,
  preset = 'TEAM',
}: {
  spec: PageSpec;
  /** The Team Performance page adds the telecaller-to-sales handoff report. */
  showHandoffs?: boolean;
  preset?: PerformancePreset;
}) {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [range, setRange] = useState(() => performanceRangeForLastDays(7));
  // null: every team in scope.
  const [branchId, setBranchId] = useState<string | null>(null);
  const showroom = preset === 'SHOWROOM';
  const query = usePersistedQuery({
    queryKey: ['team-manager-performance', ...queryScope, range.from, range.to, branchId],
    queryFn: ({ signal }) => fetchTeamManagerPerformance(range, signal, branchId),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    placeholderData: keepPreviousData,
    persist: { version: 1, schema: teamPerformanceSchema },
  });
  useTenantRealtimeInvalidation(
    session?.organizationId,
    (['leads', 'communications', 'work', 'sales'] as const).map((resource) => ({
      resource,
      queryKeys: [['team-manager-performance', ...queryScope]],
      minIntervalMs: AGGREGATE_REALTIME_MIN_INTERVAL_MS,
    })),
  );
  if (query.isPending) return <TeamManagerPerformanceSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title={
            showroom ? 'Showroom performance is unavailable' : 'Team performance is unavailable'
          }
          description={
            showroom
              ? 'Confirm that your branches have active sales teams and that you have the required CRM permissions.'
              : 'Confirm that you manage an active team and have the required CRM permissions.'
          }
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );

  const data = query.data;
  const { kpis } = data;
  const share = (value: number) =>
    kpis.leads ? `${formatPercent((value * 100) / kpis.leads)} of leads` : 'No leads in period';
  const metrics: Metric[] = [
    {
      label: 'Leads assigned',
      value: formatNumber(kpis.leads),
      helper: `${formatNumber(kpis.contacted)} contacted`,
      icon: Users,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Qualified',
      value: kpis.qualified === undefined ? '—' : formatNumber(kpis.qualified),
      helper: kpis.qualified === undefined ? 'Reached qualification' : share(kpis.qualified),
      icon: ClipboardCheck,
      tone: 'bg-teal-50 text-teal-600',
    },
    {
      label: 'Test drives',
      value: formatNumber(kpis.test_drives),
      helper: 'Scheduled, not cancelled',
      icon: Trophy,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Quotations',
      value: formatNumber(kpis.quotations),
      helper: 'Created in period',
      icon: FileText,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Bookings',
      value: formatNumber(kpis.bookings),
      helper: 'Non-cancelled bookings',
      icon: CarFront,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: showroom ? 'Showroom conversion' : 'Team conversion',
      value: `${kpis.conversion.toFixed(1)}%`,
      helper: 'Bookings per lead in period',
      icon: Target,
      tone: 'bg-violet-50 text-violet-600',
    },
  ];
  const funnel = [
    { name: 'Leads', value: kpis.leads },
    { name: 'Contacted', value: kpis.contacted },
    ...(kpis.qualified === undefined ? [] : [{ name: 'Qualified', value: kpis.qualified }]),
    { name: 'Test drive', value: kpis.test_drives },
    { name: 'Quotation', value: kpis.quotations },
    { name: 'Booking', value: kpis.bookings },
  ];
  const showTeam = showroom || new Set(data.leaderboard.map((member) => member.team_name)).size > 1;
  const columnCount = showTeam ? 11 : 10;
  // Ranked on bookings, which only a consultant makes; a telecaller in the top
  // three read as a 0% "top performer".
  const leaders = data.leaderboard.filter((member) => !isTelecallerMember(member)).slice(0, 3);

  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description={
          showroom
            ? 'Every telecaller and sales consultant in your showroom teams, compared on the same period.'
            : showHandoffs
              ? 'Compare your team members on real, authorized activity and their handoffs to Sales.'
              : 'Compare your team members on real, authorized activity.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {showroom ? (
              <BranchPicker
                branches={data.branches}
                value={branchId}
                onChange={setBranchId}
                allLabel="All branches"
              />
            ) : null}
            <PerformanceDateRangeSelector value={range} onChange={setRange} />
          </div>
        }
      />
      <KpiGrid metrics={metrics} />
      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="Performance trend">
          <EChart
            kind="line"
            data={data.daily.map((day) => ({
              name: day.name,
              value: day.calls,
              secondary: day.test_drives,
            }))}
            seriesNames={['Calls', 'Test drives']}
          />
        </SectionCard>
        {/* Leads, contacted and qualified follow the leads created in the period;
            later steps count activity in it, so they can outgrow an earlier step. */}
        {funnelNarrows(funnel) ? (
          <SectionCard
            title="Conversion funnel"
            description="From leads created in the period to bookings"
          >
            <EChart
              kind="funnel"
              data={funnel}
              funnelMode="staged"
              funnelStages={funnel.length}
              funnelLabels="side"
            />
          </SectionCard>
        ) : (
          <SectionCard
            title="Sales steps in the period"
            description="Bookings can come from leads assigned before the period"
          >
            <EChart
              kind="bar"
              data={funnel}
              series={[{ name: 'Count', values: funnel.map((stage) => stage.value) }]}
            />
          </SectionCard>
        )}
      </div>
      <SectionCard title="Top performers" contentClassName="grid gap-3 md:grid-cols-3">
        {leaders.length ? (
          leaders.map((member, index) => (
            <div key={member.user_id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="grid size-8 place-items-center rounded-full bg-amber-50 text-xs font-bold text-amber-700">
                  {index + 1}
                </span>
                <Badge variant={index === 0 ? 'success' : 'outline'}>
                  {member.conversion.toFixed(1)}%
                </Badge>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <span className="grid size-9 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                  {initials(member.full_name)}
                </span>
                <p className="min-w-0 truncate text-sm font-semibold">{member.full_name}</p>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <span>
                  Leads <b className="ml-1 text-foreground">{member.leads}</b>
                </span>
                <span>
                  Bookings <b className="ml-1 text-foreground">{member.bookings}</b>
                </span>
                <span>
                  Calls <b className="ml-1 text-foreground">{member.calls}</b>
                </span>
                <span>
                  Drives <b className="ml-1 text-foreground">{member.test_drives}</b>
                </span>
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No active consultants are assigned.</p>
        )}
      </SectionCard>
      <SectionCard
        title={showroom ? 'Showroom leaderboard' : 'Team leaderboard'}
        flush
        contentClassName="overflow-x-auto"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Member</TableHead>
              {showTeam ? <TableHead>Team</TableHead> : null}
              <TableHead>Leads</TableHead>
              <TableHead>Qualified</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead>Test drives</TableHead>
              <TableHead>Quotations</TableHead>
              <TableHead>Bookings</TableHead>
              <TableHead>Conversion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.leaderboard.map((member, index) => (
              <TableRow key={member.user_id}>
                <TableCell className="font-semibold">{index + 1}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="grid size-8 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                      {initials(member.full_name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{member.full_name}</span>
                      {teamMemberRole(member) ? (
                        <span className="block text-[11px] text-muted-foreground">
                          {teamMemberRole(member)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </TableCell>
                {showTeam ? (
                  <TableCell className="text-xs text-muted-foreground">
                    {member.team_name ?? '—'}
                  </TableCell>
                ) : null}
                <TableCell>{member.leads}</TableCell>
                <TableCell>{member.qualified ?? '—'}</TableCell>
                <TableCell>{member.calls}</TableCell>
                <TableCell>{member.connected_calls}</TableCell>
                <TableCell>{member.test_drives}</TableCell>
                <TableCell>{member.quotations}</TableCell>
                <TableCell>{member.bookings}</TableCell>
                <TableCell>
                  {isTelecallerMember(member) ? (
                    <span className="text-muted-foreground" title="Telecallers hand leads to Sales">
                      —
                    </span>
                  ) : (
                    <Badge variant={member.conversion >= 10 ? 'success' : 'outline'}>
                      {member.conversion.toFixed(1)}%
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!data.leaderboard.length && (
              <TableRow>
                <TableCell
                  colSpan={columnCount}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {showroom
                    ? 'No active members are assigned to teams in this branch.'
                    : 'No active members are assigned to your managed team.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </SectionCard>
      {showHandoffs ? (
        <SalesHandoffReport
          preset={showroom ? 'SHOWROOM' : 'TEAM'}
          range={range}
          branchId={branchId}
          leadBasePath={showroom ? '/showroom-manager/leads' : '/team-manager/leads'}
        />
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        {showroom
          ? 'Results include only records assigned to active teams in your branches.'
          : 'Results include only records assigned to your active managed team.'}{' '}
        {formatNumber(kpis.connected_calls)} of {formatNumber(kpis.calls)} calls connected; talk
        time {formatDuration(kpis.talk_seconds)}.
      </p>
    </div>
  );
}

/**
 * The Team Manager dashboard's "Team overview" (PRD 54.3 §4): every member of
 * the managed team on one row. It reads the same 7-day query as Team
 * Performance, so opening either page warms the other.
 */
export function TeamOverviewCard() {
  const session = useWorkspaceSession();
  const queryScope = workspaceQueryScope(session);
  const [range] = useState(() => performanceRangeForLastDays(7));
  const query = usePersistedQuery({
    queryKey: ['team-manager-performance', ...queryScope, range.from, range.to, null],
    queryFn: ({ signal }) => fetchTeamManagerPerformance(range, signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
    persist: { version: 1, schema: teamPerformanceSchema },
  });
  return (
    <SectionCard
      title="Team overview"
      description="Last 7 days, by team member"
      actionHref="/team-manager/team-performance"
      actionLabel="Team performance"
      flush
      contentClassName="overflow-x-auto"
    >
      {query.isPending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : query.isError || !query.data ? (
        <ErrorState
          className="border-0"
          title="Team overview is unavailable"
          onRetry={() => void query.refetch()}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="hidden md:table-cell">Role</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Connected</TableHead>
              <TableHead className="text-right">Test drives</TableHead>
              <TableHead className="text-right">Quotations</TableHead>
              <TableHead className="text-right">Bookings</TableHead>
              <TableHead className="text-right">Conversion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.leaderboard.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell className="font-medium">{member.full_name}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {teamMemberRole(member) ?? '—'}
                </TableCell>
                <TableCell className="text-right">{formatNumber(member.leads)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.calls)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.connected_calls)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.test_drives)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.quotations)}</TableCell>
                <TableCell className="text-right">{formatNumber(member.bookings)}</TableCell>
                <TableCell className="text-right">
                  {isTelecallerMember(member) ? '—' : formatPercent(member.conversion)}
                </TableCell>
              </TableRow>
            ))}
            {!query.data.leaderboard.length && (
              <TableRow>
                <TableCell colSpan={9} className="p-0">
                  <EmptyState
                    bare
                    title="No active members in your managed team"
                    description="Members appear here once they are assigned to your team."
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
