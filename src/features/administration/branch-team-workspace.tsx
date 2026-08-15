'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  TriangleAlert,
  UserRoundCog,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchBranchAdministrationWorkspace,
  fetchBranchTeamPermissions,
  fetchTeamAdministrationWorkspace,
  type BranchAdministrationRecord,
  type BranchAdministrationWorkspace,
  type BranchTeamPermissions,
  type TeamAdministrationRecord,
  type TeamAdministrationWorkspace,
} from './branch-team-api';
import {
  BranchAccessDialog,
  BranchEditorDialog,
  TeamEditorDialog,
  TeamMembersDialog,
} from './branch-team-dialogs';
import {
  administrationPageSizes,
  parseAdministrationQuery,
  toAdministrationQueryString,
  type AdministrationKind,
  type AdministrationQuery,
  type AdministrationSort,
  type AdministrationStatus,
  type BranchWorkspacePreset,
} from './branch-team-query';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

function assignmentLabel(value: string) {
  return value === 'ROUND_ROBIN' ? 'Round Robin' : 'Manual Assignment';
}

function branchMetrics(result: BranchAdministrationWorkspace): Metric[] {
  return [
    { label: 'Total branches', value: result.kpis.total.toLocaleString() },
    { label: 'Active', value: result.kpis.active.toLocaleString() },
    { label: 'Inactive', value: result.kpis.inactive.toLocaleString() },
    { label: 'Users assigned', value: result.kpis.users_assigned.toLocaleString() },
  ];
}

function teamMetrics(result: TeamAdministrationWorkspace): Metric[] {
  return [
    { label: 'Total teams', value: result.kpis.total.toLocaleString() },
    { label: 'Active teams', value: result.kpis.active.toLocaleString() },
    { label: 'Telecallers / BDC', value: result.kpis.telecallers.toLocaleString() },
    { label: 'Sales consultants', value: result.kpis.consultants.toLocaleString() },
  ];
}

function AdministrationPagination({
  total,
  query,
  onQueryChange,
}: {
  total: number;
  query: AdministrationQuery;
  onQueryChange: (next: Partial<AdministrationQuery>) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        Showing {total ? (query.page - 1) * query.pageSize + 1 : 0}–
        {Math.min(query.page * query.pageSize, total)} of {total}
      </p>
      <div className="flex items-center gap-2">
        <span className="mr-2 text-xs text-muted-foreground">
          Page {query.page} of {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={query.page <= 1}
          onClick={() => onQueryChange({ page: query.page - 1 })}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={query.page >= pages}
          onClick={() => onQueryChange({ page: query.page + 1 })}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AdministrationFilters({
  kind,
  query,
  branches,
  onQueryChange,
}: {
  kind: AdministrationKind;
  query: AdministrationQuery;
  branches: Array<{ id: string; name: string }>;
  onQueryChange: (next: Partial<AdministrationQuery>) => void;
}) {
  const sorts =
    kind === 'branches'
      ? [
          ['updated:desc', 'Recently configured'],
          ['updated:asc', 'Oldest configured'],
          ['name:asc', 'Name A–Z'],
          ['name:desc', 'Name Z–A'],
          ['created:desc', 'Recently created'],
          ['teams:desc', 'Most teams'],
          ['users:desc', 'Most users'],
        ]
      : [
          ['updated:desc', 'Recently configured'],
          ['updated:asc', 'Oldest configured'],
          ['name:asc', 'Name A–Z'],
          ['name:desc', 'Name Z–A'],
          ['members:desc', 'Most members'],
          ['leads:desc', 'Most active leads'],
        ];
  return (
    <CardHeader className="border-b p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1 xl:max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query.search}
            onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
            className="pl-9"
            maxLength={160}
            placeholder={
              kind === 'branches'
                ? 'Search branch, code, city, contact…'
                : 'Search team, branch, or manager…'
            }
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:flex">
          <Select
            value={query.status}
            onValueChange={(value) =>
              onQueryChange({ status: value as AdministrationStatus, page: 1 })
            }
          >
            <SelectTrigger className="w-full xl:w-[145px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="INACTIVE">Inactive</SelectItem>
            </SelectContent>
          </Select>
          {kind === 'teams' && (
            <Select
              value={query.branchId}
              onValueChange={(value) => onQueryChange({ branchId: value, page: 1 })}
            >
              <SelectTrigger className="w-full xl:w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={query.sort}
            onValueChange={(value) => onQueryChange({ sort: value as AdministrationSort, page: 1 })}
          >
            <SelectTrigger className="w-full xl:w-[185px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sorts.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) =>
              onQueryChange({ pageSize: Number(value) as AdministrationQuery['pageSize'], page: 1 })
            }
          >
            <SelectTrigger className="w-full xl:w-[105px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {administrationPageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </CardHeader>
  );
}

function BranchTable({
  result,
  query,
  preset,
  permissions,
  isFetching,
  onQueryChange,
  onEdit,
  onAccess,
}: {
  result: BranchAdministrationWorkspace;
  query: AdministrationQuery;
  preset: BranchWorkspacePreset;
  permissions: BranchTeamPermissions;
  isFetching: boolean;
  onQueryChange: (next: Partial<AdministrationQuery>) => void;
  onEdit: (record: BranchAdministrationRecord) => void;
  onAccess: (record: BranchAdministrationRecord) => void;
}) {
  const columns = useMemo<ColumnDef<BranchAdministrationRecord>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Branch',
        cell: ({ row }) => (
          <div className="min-w-44">
            <p className="font-semibold">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">
              Created {formatDate(row.original.created_at)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'code',
        header: 'Code',
        cell: ({ row }) => <Badge variant="outline">{row.original.code}</Badge>,
      },
      {
        id: 'location',
        header: 'Location',
        cell: ({ row }) => (
          <div className="min-w-40">
            <p>{row.original.city || 'City not set'}</p>
            <p className="text-xs text-muted-foreground">
              {[row.original.state, row.original.postal_code].filter(Boolean).join(' · ') ||
                'Address incomplete'}
            </p>
          </div>
        ),
      },
      {
        id: 'manager',
        header: 'Managers',
        cell: ({ row }) => (
          <span className="block max-w-52 truncate">
            {row.original.manager_names || 'Unassigned'}
          </span>
        ),
      },
      {
        id: 'structure',
        header: 'Structure',
        cell: ({ row }) => (
          <div className="min-w-28">
            <p>{row.original.active_team_count} active teams</p>
            <p className="text-xs text-muted-foreground">{row.original.user_count} users</p>
          </div>
        ),
      },
      {
        id: 'connections',
        header: preset === 'ACCESS' ? 'Access / integrations' : 'Integrations',
        cell: ({ row }) => (
          <div className="min-w-28">
            <p>{row.original.integration_count} connected</p>
            {preset === 'ACCESS' && (
              <p className="text-xs text-muted-foreground">
                {row.original.explicit_access_count} explicit grants
              </p>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'active',
        header: 'Status',
        cell: ({ row }) => <StatusBadge value={row.original.active ? 'ACTIVE' : 'INACTIVE'} />,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Branch actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {preset === 'MANAGE' && permissions.canManageBranches && (
                <DropdownMenuItem onSelect={() => onEdit(row.original)}>
                  <Pencil className="size-4" />
                  Edit configuration
                </DropdownMenuItem>
              )}
              {permissions.canManageUsers && (
                <DropdownMenuItem onSelect={() => onAccess(row.original)}>
                  <ShieldCheck className="size-4" />
                  Manage branch access
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [onAccess, onEdit, permissions.canManageBranches, permissions.canManageUsers, preset],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: result.total,
  });
  return (
    <Card className={`overflow-hidden shadow-none ${isFetching ? 'opacity-80' : ''}`}>
      <AdministrationFilters
        kind="branches"
        query={query}
        branches={[]}
        onQueryChange={onQueryChange}
      />
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!result.records.length && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-28 text-center text-muted-foreground"
                  >
                    No branches match the current filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <AdministrationPagination
          total={result.total}
          query={query}
          onQueryChange={onQueryChange}
        />
      </CardContent>
    </Card>
  );
}

function TeamTable({
  result,
  query,
  permissions,
  isFetching,
  onQueryChange,
  onEdit,
  onMembers,
}: {
  result: TeamAdministrationWorkspace;
  query: AdministrationQuery;
  permissions: BranchTeamPermissions;
  isFetching: boolean;
  onQueryChange: (next: Partial<AdministrationQuery>) => void;
  onEdit: (record: TeamAdministrationRecord) => void;
  onMembers: (record: TeamAdministrationRecord) => void;
}) {
  const columns = useMemo<ColumnDef<TeamAdministrationRecord>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Team',
        cell: ({ row }) => (
          <div className="min-w-40">
            <p className="font-semibold">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">
              Updated {formatDate(row.original.updated_at)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'branch_name',
        header: 'Branch',
        cell: ({ row }) => (
          <div>
            <p>{row.original.branch_name}</p>
            {!row.original.branch_active && (
              <p className="text-xs text-amber-700">Branch inactive</p>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'manager_name',
        header: 'Team manager',
        cell: ({ row }) => row.original.manager_name ?? 'Unassigned',
      },
      {
        id: 'members',
        header: 'Members',
        cell: ({ row }) => (
          <div className="min-w-32">
            <p>{row.original.member_count} total</p>
            <p className="text-xs text-muted-foreground">
              {row.original.telecaller_count} BDC · {row.original.consultant_count} sales
            </p>
          </div>
        ),
      },
      {
        id: 'assignment',
        header: 'Assignment modes',
        cell: ({ row }) => (
          <div className="min-w-44">
            <p>Fresh: {assignmentLabel(row.original.fresh_assignment_mode)}</p>
            <p className="text-xs text-muted-foreground">
              Qualified: {assignmentLabel(row.original.qualified_assignment_mode)}
            </p>
          </div>
        ),
      },
      {
        id: 'workload',
        header: 'Open workload',
        cell: ({ row }) => (
          <div>
            <p>{row.original.active_lead_count} active leads</p>
            <p className="text-xs text-muted-foreground">
              {row.original.open_followup_count} follow-ups
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'active',
        header: 'Status',
        cell: ({ row }) => <StatusBadge value={row.original.active ? 'ACTIVE' : 'INACTIVE'} />,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          permissions.canManageTeams ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label="Team actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onEdit(row.original)}>
                  <Pencil className="size-4" />
                  Edit team
                </DropdownMenuItem>
                {permissions.canManageUsers && (
                  <DropdownMenuItem onSelect={() => onMembers(row.original)}>
                    <UserRoundCog className="size-4" />
                    Manage members
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [onEdit, onMembers, permissions.canManageTeams, permissions.canManageUsers],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: result.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: result.total,
  });
  return (
    <Card className={`overflow-hidden shadow-none ${isFetching ? 'opacity-80' : ''}`}>
      <AdministrationFilters
        kind="teams"
        query={query}
        branches={result.branches}
        onQueryChange={onQueryChange}
      />
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!result.records.length && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-28 text-center text-muted-foreground"
                  >
                    No teams match the current filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <AdministrationPagination
          total={result.total}
          query={query}
          onQueryChange={onQueryChange}
        />
      </CardContent>
    </Card>
  );
}

export function BranchTeamWorkspace({
  kind,
  preset = 'MANAGE',
  spec,
}: {
  kind: AdministrationKind;
  preset?: BranchWorkspacePreset;
  role: string;
  spec: PageSpec;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(() => parseAdministrationQuery(searchParams, kind));
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const [branchEditor, setBranchEditor] = useState<BranchAdministrationRecord | null | 'create'>(
    null,
  );
  const [branchAccess, setBranchAccess] = useState<BranchAdministrationRecord | null>(null);
  const [teamEditor, setTeamEditor] = useState<TeamAdministrationRecord | null | 'create'>(null);
  const [teamMembers, setTeamMembers] = useState<TeamAdministrationRecord | null>(null);
  const queryClient = useQueryClient();
  const permissions = useQuery({
    queryKey: ['branch-team-permissions'],
    queryFn: fetchBranchTeamPermissions,
    staleTime: 60_000,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'administration',
      queryKeys: [
        ['branch-team-workspace', permissions.data?.organizationId],
        ['team-administration-options'],
        ['branch-access-options'],
      ],
    },
  ]);
  const workspace = useQuery<BranchAdministrationWorkspace | TeamAdministrationWorkspace>({
    queryKey: [
      'branch-team-workspace',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      kind,
      preset,
      requestQuery,
    ],
    queryFn: () =>
      kind === 'branches'
        ? fetchBranchAdministrationWorkspace(requestQuery, preset)
        : fetchTeamAdministrationWorkspace(requestQuery),
    enabled: Boolean(
      permissions.data &&
      (kind === 'branches' ? permissions.data.canManageBranches : permissions.data.canManageTeams),
    ),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<AdministrationQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toAdministrationQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['branch-team-workspace', permissions.data?.organizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ['team-administration-options'] });
    void queryClient.invalidateQueries({ queryKey: ['branch-access-options'] });
    void queryClient.invalidateQueries({ queryKey: ['tenant-user-administration'] });
  }, [permissions.data?.organizationId, queryClient]);

  if (permissions.isPending || (workspace.isPending && permissions.data)) return <PageSkeleton />;
  if (permissions.isError || workspace.isError || !permissions.data || !workspace.data)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Administration workspace is unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your permission/scope or migration state needs attention. Reference:
            GDM-BRANCH-TEAM-QUERY.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  const isBranchResult = kind === 'branches';
  const branchResult = isBranchResult ? (workspace.data as BranchAdministrationWorkspace) : null;
  const teamResult = !isBranchResult ? (workspace.data as TeamAdministrationWorkspace) : null;
  const canCreate =
    kind === 'branches'
      ? preset === 'MANAGE' &&
        ['ALL_BRANCHES', 'ORGANIZATION'].includes(permissions.data.dataScope) &&
        permissions.data.canManageBranches
      : permissions.data.canManageTeams;
  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {canCreate && (
          <Button
            className="shrink-0 sm:mt-7"
            onClick={() =>
              kind === 'branches' ? setBranchEditor('create') : setTeamEditor('create')
            }
          >
            <Plus className="size-4" />
            {kind === 'branches' ? 'Create branch' : 'Create team'}
          </Button>
        )}
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={branchResult ? branchMetrics(branchResult) : teamMetrics(teamResult!)} />
        {branchResult ? (
          <BranchTable
            result={branchResult}
            query={query}
            preset={preset}
            permissions={permissions.data}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
            onEdit={setBranchEditor}
            onAccess={setBranchAccess}
          />
        ) : (
          <TeamTable
            result={teamResult!}
            query={query}
            permissions={permissions.data}
            isFetching={workspace.isFetching}
            onQueryChange={onQueryChange}
            onEdit={setTeamEditor}
            onMembers={setTeamMembers}
          />
        )}
      </div>
      {branchEditor && (
        <BranchEditorDialog
          key={
            branchEditor === 'create' ? 'new-branch' : `${branchEditor.id}:${branchEditor.version}`
          }
          record={branchEditor === 'create' ? null : branchEditor}
          open
          onOpenChange={(open) => !open && setBranchEditor(null)}
          onSaved={invalidate}
        />
      )}
      {branchAccess && (
        <BranchAccessDialog
          key={`${branchAccess.id}:${branchAccess.version}`}
          branch={branchAccess}
          open
          onOpenChange={(open) => !open && setBranchAccess(null)}
          onSaved={invalidate}
        />
      )}
      {teamEditor && (
        <TeamEditorDialog
          key={teamEditor === 'create' ? 'new-team' : `${teamEditor.id}:${teamEditor.version}`}
          record={teamEditor === 'create' ? null : teamEditor}
          open
          onOpenChange={(open) => !open && setTeamEditor(null)}
          onSaved={invalidate}
        />
      )}
      {teamMembers && (
        <TeamMembersDialog
          key={`${teamMembers.id}:${teamMembers.version}`}
          team={teamMembers}
          open
          onOpenChange={(open) => !open && setTeamMembers(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}
