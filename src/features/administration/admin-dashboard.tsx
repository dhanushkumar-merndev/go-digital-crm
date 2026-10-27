'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  Cable,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  UserCog,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { AttentionList } from '@/components/shared/attention-list';
import { KpiGrid, kpiGridColumns } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { roleHasNavigationSlug } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import type { Metric, PageSpec } from '@/lib/domain';
import { formatNumber } from '@/lib/format';
import {
  DASHBOARD_QUERY_GC_TIME_MS,
  DASHBOARD_QUERY_STALE_TIME_MS,
} from '@/lib/query/cache-policy';
import { cn } from '@/lib/utils';
import { adminOverviewKey, fetchAdminOverview, type AdminOverview } from './admin-overview-api';

function pageHref(role: RoleKey, slug: string, query = '') {
  return roleHasNavigationSlug(role, slug) ? `/${role}/${slug}${query}` : undefined;
}

function metrics(data: AdminOverview, role: RoleKey): Metric[] {
  const { kpis } = data;
  const branchesHref = pageHref(role, 'branches') ?? pageHref(role, 'branches-access');
  const list: Metric[] = [
    {
      label: 'Branches',
      value: formatNumber(kpis.branches),
      helper: `${formatNumber(kpis.active_branches)} active`,
      icon: Building2,
      href: branchesHref,
    },
    {
      label: 'Users',
      value: formatNumber(kpis.users),
      helper: `${formatNumber(kpis.active_users)} active`,
      icon: UsersRound,
      href: pageHref(role, 'users'),
    },
    {
      label: 'Sales users',
      value: formatNumber(kpis.sales_users),
      helper: 'Telecaller to GM',
      icon: UserCheck,
    },
    {
      label: 'Operations users',
      value: formatNumber(kpis.operational_users),
      helper: 'Inventory, finance, delivery and care',
      icon: Wrench,
    },
    {
      label: 'MFA required',
      value: formatNumber(kpis.mfa_required_users),
      helper: 'Active users who must use TOTP',
      icon: ShieldCheck,
    },
    {
      label: 'Inactive users',
      value: formatNumber(kpis.inactive_users),
      helper: 'Disabled, history kept',
      icon: UserCog,
      href: pageHref(role, 'users', '?status=inactive'),
    },
  ];
  // Integrations are tenant-wide, so a branch-scoped administrator has none to read.
  if (data.organization_wide)
    list.push(
      {
        label: 'Integrations connected',
        value: formatNumber(kpis.integrations_connected),
        helper: 'Provider connections',
        icon: Cable,
        href: pageHref(role, 'integrations'),
      },
      {
        label: 'Integration issues',
        value: formatNumber(kpis.integration_issues),
        helper: 'Failed, disconnected or erroring',
        icon: TriangleAlert,
        href: pageHref(role, 'integrations'),
      },
    );
  return list;
}

function attention(data: AdminOverview, role: RoleKey) {
  const { kpis } = data;
  const items = [];
  if (kpis.integration_issues)
    items.push({
      title: `${formatNumber(kpis.integration_issues)} integration${kpis.integration_issues === 1 ? '' : 's'} need attention`,
      detail: 'A provider connection failed, disconnected or reported an error.',
      severity: 'high' as const,
      href: pageHref(role, 'integrations'),
    });
  if (kpis.branches > kpis.active_branches)
    items.push({
      title: `${formatNumber(kpis.branches - kpis.active_branches)} branch${kpis.branches - kpis.active_branches === 1 ? ' is' : 'es are'} inactive`,
      detail: 'Inactive branches receive no leads and their users cannot be assigned work.',
      severity: 'medium' as const,
      href: pageHref(role, 'branches') ?? pageHref(role, 'branches-access'),
    });
  if (kpis.inactive_users)
    items.push({
      title: `${formatNumber(kpis.inactive_users)} disabled user${kpis.inactive_users === 1 ? '' : 's'}`,
      detail: 'Review whether they should be re-enabled or stay disabled.',
      severity: 'low' as const,
      href: pageHref(role, 'users', '?status=inactive'),
    });
  if (data.organization_wide && kpis.integrations_connected === 0)
    items.push({
      title: 'No lead source is connected',
      detail: 'Connect Meta, the website form or a portal so leads arrive without manual entry.',
      severity: 'medium' as const,
      href: pageHref(role, 'integrations'),
    });
  return items;
}

/**
 * The Client Admin and System Administrator home (PRD 54.6 §7-11, 54.8 §6-9):
 * how the dealership is set up and what needs an administrator, read from
 * get_admin_overview within the caller's user.manage scope.
 */
// PRD 54.6 §8: the sales hierarchy by role, every department role as one
// "Operational users" slice. Twenty role slices read as slivers.
const salesRoleGroups: Array<[RegExp, string]> = [
  [/telecaller|bdc/i, 'Telecaller'],
  [/sales consultant/i, 'Sales Consultant'],
  [/team manager/i, 'Team Manager'],
  [/showroom manager|sales manager/i, 'Sales Manager'],
  [/\bgm\b|general manager/i, 'GM'],
  [/system admin/i, 'System Administrator'],
  [/client admin|business owner/i, 'Administration'],
];

function roleGroups(roles: Array<{ name: string; value: number }>) {
  const totals = new Map<string, number>();
  for (const role of roles) {
    const group =
      salesRoleGroups.find(([pattern]) => pattern.test(role.name))?.[1] ?? 'Operational users';
    totals.set(group, (totals.get(group) ?? 0) + role.value);
  }
  return [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export function AdminDashboard({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: [...adminOverviewKey, ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchAdminOverview(signal),
    staleTime: DASHBOARD_QUERY_STALE_TIME_MS,
    gcTime: DASHBOARD_QUERY_GC_TIME_MS,
  });
  const header = <PageHeader spec={{ ...spec, primaryAction: undefined }} />;

  if (query.isPending)
    return (
      <PageShell>
        {header}
        <div className={cn('grid gap-2.5', kpiGridColumns(8))}>
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-12">
          <Skeleton className="h-[320px] rounded-xl xl:col-span-5" />
          <Skeleton className="h-[320px] rounded-xl xl:col-span-7" />
        </div>
      </PageShell>
    );
  if (query.isError || !query.data)
    return (
      <PageShell>
        {header}
        <ErrorState
          title="The administration overview is unavailable"
          description="It needs an active Client Admin or System Administrator assignment with user management."
          reference="GDM-ADMIN-OVERVIEW"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </PageShell>
    );

  const data = query.data;
  return (
    <PageShell>
      {header}
      <KpiGrid metrics={metrics(data, role)} />
      <div className="grid gap-4 xl:grid-cols-12">
        <SectionCard
          title="Users by role"
          description="Active users, by their highest role"
          className="xl:col-span-5"
          actionHref={pageHref(role, 'users')}
          actionLabel="Users"
        >
          {data.roles.length ? (
            <EChart kind="donut" data={roleGroups(data.roles)} className="h-[280px]" />
          ) : (
            <EmptyState bare title="No users in your scope yet" />
          )}
        </SectionCard>
        <SectionCard
          title="Users per branch"
          description="Users assigned to each branch in your scope"
          className="xl:col-span-7"
        >
          {data.branches.length ? (
            <EChart
              kind="bar"
              data={data.branches}
              seriesNames={['Users', '']}
              className="h-[280px]"
            />
          ) : (
            <EmptyState bare title="No branches in your scope yet" />
          )}
        </SectionCard>
      </div>
      <AttentionList items={attention(data, role)} />
    </PageShell>
  );
}
