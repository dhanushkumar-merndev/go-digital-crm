'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, Plus, Search, ShieldCheck } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  fetchDelegablePermissions,
  fetchRoleWorkspace,
  isRoleVersionConflict,
  saveDelegatedRole,
  type RoleAdministrationRecord,
  type RoleWorkspaceResult,
} from './role-workspace-api';
import {
  parseRoleWorkspaceQuery,
  roleFilterValues,
  toCustomRoleKey,
  toRoleWorkspaceQueryString,
  type RoleFilter,
  type RoleWorkspaceQuery,
} from './role-workspace-query';

const filterLabels: Record<RoleFilter, string> = {
  all: 'All roles',
  system: 'System presets',
  custom: 'Custom roles',
  mfa: 'MFA required',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function toMetrics(kpis: RoleWorkspaceResult['kpis']): Metric[] {
  return [
    { label: 'Role presets', value: kpis.total_roles.toLocaleString() },
    {
      label: 'Custom roles',
      value: kpis.custom_roles.toLocaleString(),
      helper: 'Delegated below your ceiling',
    },
    {
      label: 'MFA roles',
      value: kpis.mfa_roles.toLocaleString(),
      helper: 'Additional assurance required',
    },
    {
      label: 'Active assignments',
      value: kpis.assigned_users.toLocaleString(),
      helper: 'Role-to-user assignments',
    },
  ];
}

function RoleRealtimeBridge({ organizationId }: { organizationId: string }) {
  useTenantRealtimeInvalidation(organizationId, [
    { resource: 'administration', queryKeys: [['role-administration']] },
  ]);
  return null;
}

function RoleEditorDialog({
  record,
  authorityCeiling,
  onClose,
  onSaved,
}: {
  record: RoleAdministrationRecord | null;
  authorityCeiling: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(record?.name ?? '');
  const [authorityLevel, setAuthorityLevel] = useState(
    record?.authority_level ?? Math.max(1, authorityCeiling - 100),
  );
  const [requireMfa, setRequireMfa] = useState(record?.mfa_required ?? false);
  const [selectedPermissions, setSelectedPermissions] = useState(record?.permissions ?? []);
  const [permissionSearch, setPermissionSearch] = useState('');
  const permissions = useQuery({
    queryKey: ['delegable-role-permissions'],
    queryFn: fetchDelegablePermissions,
  });
  const delegableKeys = useMemo(
    () => new Set((permissions.data ?? []).map((permission) => permission.permission_key)),
    [permissions.data],
  );
  const outsideCeiling = record?.permissions.filter((key) => !delegableKeys.has(key)) ?? [];
  const normalizedPermissionSearch = permissionSearch.trim().toLowerCase();
  const filteredPermissions = (permissions.data ?? []).filter(
    (permission) =>
      !normalizedPermissionSearch ||
      permission.permission_key.toLowerCase().includes(normalizedPermissionSearch) ||
      permission.module.toLowerCase().includes(normalizedPermissionSearch) ||
      permission.description.toLowerCase().includes(normalizedPermissionSearch),
  );
  const roleKey = record?.role_key ?? toCustomRoleKey(name);
  const mutation = useMutation({
    mutationFn: saveDelegatedRole,
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const selectedDelegablePermissions = selectedPermissions.filter((key) => delegableKeys.has(key));
  const valid =
    name.trim().length >= 2 &&
    name.trim().length <= 100 &&
    !name.toLowerCase().includes('team leader') &&
    authorityLevel >= 1 &&
    authorityLevel < authorityCeiling &&
    selectedDelegablePermissions.length > 0 &&
    selectedDelegablePermissions.length <= 50;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit custom role' : 'Create custom role'}</DialogTitle>
          <DialogDescription>
            Custom authority and permissions must remain strictly below your own delegation ceiling.
            System role presets are immutable.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            mutation.mutate({
              roleId: record?.id,
              expectedUpdatedAt: record?.updated_at,
              name,
              roleKey,
              authorityLevel,
              requireMfa,
              permissionKeys: selectedDelegablePermissions,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Role name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={100}
                required
                placeholder="Regional lead reviewer"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Stable role key
              <Input value={roleKey} disabled className="font-mono text-xs" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Authority level
              <Input
                type="number"
                value={authorityLevel}
                min={1}
                max={authorityCeiling - 1}
                onChange={(event) => setAuthorityLevel(Number(event.target.value))}
                required
              />
              <span className="text-xs font-normal text-muted-foreground">
                Allowed range: 1–{authorityCeiling - 1}
              </span>
            </label>
            <div className="grid gap-1.5 text-sm font-medium">
              Privileged assurance
              <Button
                type="button"
                variant={requireMfa ? 'secondary' : 'outline'}
                aria-pressed={requireMfa}
                onClick={() => setRequireMfa((current) => !current)}
              >
                <ShieldCheck className="size-4" />
                {requireMfa ? 'TOTP MFA required' : 'Require TOTP MFA'}
              </Button>
            </div>
          </div>

          {outsideCeiling.length > 0 && (
            <Alert>
              <AlertTitle>Existing permissions outside your ceiling</AlertTitle>
              <AlertDescription>
                Saving removes these non-delegable keys: {outsideCeiling.join(', ')}.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-medium" htmlFor="role-permission-search">
                Permissions ({selectedDelegablePermissions.length}/50)
              </label>
              <Input
                id="role-permission-search"
                value={permissionSearch}
                onChange={(event) => setPermissionSearch(event.target.value)}
                className="h-8 w-full sm:w-60"
                maxLength={80}
                placeholder="Filter your permission ceiling"
              />
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border p-3">
              {permissions.isPending && (
                <p className="text-sm text-muted-foreground">Loading delegable permissions…</p>
              )}
              {permissions.isError && (
                <p className="text-sm text-destructive">Permission catalog is unavailable.</p>
              )}
              {filteredPermissions.map((permission) => {
                const selected = selectedPermissions.includes(permission.permission_key);
                const atLimit = selectedDelegablePermissions.length >= 50 && !selected;
                return (
                  <Button
                    key={permission.permission_key}
                    type="button"
                    variant={selected ? 'secondary' : 'outline'}
                    className="h-auto w-full flex-col items-stretch whitespace-normal p-3 text-left"
                    disabled={atLimit}
                    aria-pressed={selected}
                    onClick={() =>
                      setSelectedPermissions((current) =>
                        selected
                          ? current.filter((key) => key !== permission.permission_key)
                          : [...current, permission.permission_key],
                      )
                    }
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{permission.permission_key}</span>
                      <Badge variant="outline">{permission.module}</Badge>
                    </span>
                    <span className="mt-1 text-xs text-muted-foreground">
                      {permission.description}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>

          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>
                {isRoleVersionConflict(mutation.error)
                  ? 'This role changed in another session'
                  : 'Role not saved'}
              </AlertTitle>
              <AlertDescription>
                {isRoleVersionConflict(mutation.error)
                  ? 'Close this dialog, refresh the role list, and review the latest values.'
                  : 'Review your authority level and permission ceiling, then try again.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending || permissions.isError}>
              {mutation.isPending ? 'Saving…' : 'Save custom role'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleTable({
  data,
  query,
  isFetching,
  onQueryChange,
  onEdit,
}: {
  data: RoleWorkspaceResult;
  query: RoleWorkspaceQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<RoleWorkspaceQuery>) => void;
  onEdit: (record: RoleAdministrationRecord) => void;
}) {
  const columns = useMemo<ColumnDef<RoleAdministrationRecord>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Role',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.role_key}</p>
          </div>
        ),
      },
      {
        accessorKey: 'authority_level',
        header: 'Authority',
        cell: ({ row }) => row.original.authority_level.toLocaleString(),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <Badge variant={row.original.system_role ? 'secondary' : 'outline'}>
            {row.original.system_role ? 'System preset' : 'Custom'}
          </Badge>
        ),
      },
      {
        id: 'permissions',
        header: 'Permissions',
        cell: ({ row }) => (
          <div className="max-w-[260px]">
            <p className="text-sm">{row.original.permissions.length} granted</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.permissions.slice(0, 3).join(', ') || 'No permissions'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'assigned_users',
        header: 'Users',
      },
      {
        accessorKey: 'mfa_required',
        header: 'MFA',
        cell: ({ row }) => (
          <Badge variant={row.original.mfa_required ? 'success' : 'outline'}>
            {row.original.mfa_required ? 'Required' : 'Policy default'}
          </Badge>
        ),
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatDate(row.original.updated_at)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Action',
        cell: ({ row }) =>
          row.original.can_edit ? (
            <Button size="sm" variant="outline" onClick={() => onEdit(row.original)}>
              Edit
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Read only</span>
          ),
      },
    ],
    [onEdit],
  );
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: data.total,
  });
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={100}
              placeholder="Search this role catalog"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.filter}
              onValueChange={(value) => onQueryChange({ filter: value as RoleFilter, page: 1 })}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleFilterValues.map((filter) => (
                  <SelectItem key={filter} value={filter}>
                    {filterLabels[filter]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                onQueryChange({ sort: value as RoleWorkspaceQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="authority_desc">Highest authority</SelectItem>
                <SelectItem value="name_asc">Role A–Z</SelectItem>
                <SelectItem value="created_desc">Newest custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={isFetching ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-36 text-center">
                    <p className="font-medium">No role matches this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Change the page-local search or role filter.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="h-8 w-[82px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page >= pages}
              onClick={() => onQueryChange({ page: query.page + 1 })}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RoleWorkspace({ spec }: { spec: PageSpec }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<RoleWorkspaceQuery>(() =>
    parseRoleWorkspaceQuery(searchParameters),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<RoleAdministrationRecord | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const effectiveQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const workspace = useQuery({
    queryKey: ['role-administration', effectiveQuery],
    queryFn: () => fetchRoleWorkspace(effectiveQuery),
    placeholderData: keepPreviousData,
  });
  const changeQuery = useCallback(
    (next: Partial<RoleWorkspaceQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toRoleWorkspaceQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );
  const refresh = useCallback(() => {
    setSavedMessage('Custom role saved');
    void queryClient.invalidateQueries({ queryKey: ['role-administration'] });
    void queryClient.invalidateQueries({ queryKey: ['delegable-role-permissions'] });
  }, [queryClient]);

  if (workspace.isPending) return <PageSkeleton />;
  if (workspace.isError || !workspace.data || !workspace.data.viewer.can_manage)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Role administration is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              A current MFA session and role.manage authority are required.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <RoleRealtimeBridge organizationId={workspace.data.viewer.organization_id} />
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <div className="shrink-0 sm:pt-7">
          <Button
            onClick={() => {
              setEditRecord(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-4" />
            Create custom role
          </Button>
        </div>
      </div>
      {savedMessage && (
        <Alert variant="success">
          <AlertTitle>{savedMessage}</AlertTitle>
          <AlertDescription>
            The role catalog and eligible user options are refreshing.
          </AlertDescription>
        </Alert>
      )}
      <KpiGrid metrics={toMetrics(workspace.data.kpis)} />
      <RoleTable
        data={workspace.data}
        query={query}
        isFetching={workspace.isFetching}
        onQueryChange={changeQuery}
        onEdit={(record) => {
          setEditRecord(record);
          setEditorOpen(true);
        }}
      />
      {editorOpen && (
        <RoleEditorDialog
          key={editRecord?.id ?? 'new-role'}
          record={editRecord}
          authorityCeiling={workspace.data.viewer.authority_ceiling}
          onClose={() => {
            setEditorOpen(false);
            setEditRecord(null);
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
