'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  UserCheck,
  UserX,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  fetchUserAdministrationOptions,
  fetchUserWorkspace,
  inviteTenantUser,
  updateTenantUser,
  UserAdministrationError,
  type UserAdministrationMode,
  type UserAdministrationOptions,
  type UserAdministrationRecord,
  type UserDataScope,
  type UserWorkspaceResult,
} from './user-workspace-api';
import {
  parseUserWorkspaceQuery,
  toUserWorkspaceQueryString,
  type UserStatusFilter,
  type UserWorkspaceQuery,
} from './user-workspace-query';

const statusLabels: Record<UserStatusFilter, string> = {
  all: 'All users',
  active: 'Active',
  inactive: 'Inactive',
  'mfa-required': 'MFA required',
};

const scopeLabels: Record<UserDataScope, string> = {
  OWN_RECORDS: 'Own records',
  OWN_TEAM: 'Own team',
  ONE_BRANCH: 'One branch',
  SELECTED_BRANCHES: 'Selected branches',
  ALL_BRANCHES: 'All branches',
  ORGANIZATION: 'Organization',
};

function initials(value: string) {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function metrics(kpis: UserWorkspaceResult['kpis'], mode: UserAdministrationMode): Metric[] {
  return [
    {
      label: mode === 'CLIENT_ADMIN_BOOTSTRAP' ? 'Client Admins' : 'Managed users',
      value: kpis.total_users.toLocaleString(),
      helper: 'Within your authority and data scope',
    },
    { label: 'Active', value: kpis.active_users.toLocaleString(), helper: 'Access gate enabled' },
    {
      label: 'Inactive',
      value: kpis.inactive_users.toLocaleString(),
      helper: 'Retained without CRM access',
    },
    {
      label: 'MFA required',
      value: kpis.mfa_required.toLocaleString(),
      helper: 'TOTP assurance policy',
    },
  ];
}

function UserRealtimeBridge({ organizationId }: { organizationId: string }) {
  useTenantRealtimeInvalidation(organizationId, [
    { resource: 'administration', queryKeys: [['tenant-user-administration']] },
  ]);
  return null;
}

type EditorState = {
  email: string;
  fullName: string;
  phone: string;
  employeeId: string;
  roleId: string;
  dataScope: UserDataScope;
  scopeBranchId: string;
  selectedBranchIds: string[];
  teamIds: string[];
  active: boolean;
  mfaRequired: boolean;
};

function initialEditorState(
  record: UserAdministrationRecord | null,
  options: UserAdministrationOptions | undefined,
  mode: UserAdministrationMode,
): EditorState {
  if (record)
    return {
      email: record.email,
      fullName: record.full_name,
      phone: record.phone ?? '',
      employeeId: record.employee_id ?? '',
      roleId: record.role_id,
      dataScope: record.data_scope,
      scopeBranchId: record.scope_branch_id ?? '',
      selectedBranchIds: record.selected_branch_ids,
      teamIds: record.teams.map((team) => team.id),
      active: record.active,
      mfaRequired: record.mfa_required,
    };
  const defaultScope: UserDataScope =
    mode === 'CLIENT_ADMIN_BOOTSTRAP'
      ? 'ORGANIZATION'
      : options?.branches.length
        ? 'ONE_BRANCH'
        : 'ORGANIZATION';
  return {
    email: '',
    fullName: '',
    phone: '',
    employeeId: '',
    roleId: options?.roles[0]?.id ?? '',
    dataScope: defaultScope,
    scopeBranchId: defaultScope === 'ONE_BRANCH' ? (options?.branches[0]?.id ?? '') : '',
    selectedBranchIds: [],
    teamIds: [],
    active: true,
    mfaRequired: options?.roles[0]?.mfa_required ?? false,
  };
}

function UserEditorDialog({
  record,
  mode,
  options,
  onClose,
  onSaved,
}: {
  record: UserAdministrationRecord | null;
  mode: UserAdministrationMode;
  options: UserAdministrationOptions;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState(() => initialEditorState(record, options, mode));
  const [requestId, setRequestId] = useState('');
  const selectedRole = options.roles.find((role) => role.id === form.roleId) ?? null;
  const supportsTeams = ['team_manager', 'sales_consultant', 'telecaller_bdc'].includes(
    selectedRole?.role_key ?? '',
  );
  const availableScopes = options.data_scopes.filter(({ value }) => {
    if (mode === 'CLIENT_ADMIN_BOOTSTRAP') return !['OWN_RECORDS', 'OWN_TEAM'].includes(value);
    if (selectedRole?.role_key === 'team_manager') return value !== 'OWN_RECORDS';
    if (['sales_consultant', 'telecaller_bdc'].includes(selectedRole?.role_key ?? ''))
      return value !== 'OWN_TEAM';
    return !['OWN_RECORDS', 'OWN_TEAM'].includes(value);
  });
  const targetBranchIds =
    form.dataScope === 'ONE_BRANCH'
      ? [form.scopeBranchId]
      : form.dataScope === 'SELECTED_BRANCHES'
        ? form.selectedBranchIds
        : [];
  const visibleTeams = options.teams.filter(
    (team) => targetBranchIds.length === 0 || targetBranchIds.includes(team.branch_id),
  );
  const effectiveMfa = form.mfaRequired || Boolean(selectedRole?.mfa_required);
  const scopeShapeValid =
    (form.dataScope === 'ONE_BRANCH' && Boolean(form.scopeBranchId)) ||
    (form.dataScope === 'SELECTED_BRANCHES' && form.selectedBranchIds.length > 0) ||
    !['ONE_BRANCH', 'SELECTED_BRANCHES'].includes(form.dataScope);
  const teamShapeValid =
    !['OWN_RECORDS', 'OWN_TEAM'].includes(form.dataScope) || form.teamIds.length > 0;
  const valid =
    form.fullName.trim().length >= 2 &&
    form.fullName.trim().length <= 160 &&
    Boolean(form.roleId) &&
    scopeShapeValid &&
    teamShapeValid &&
    (record !== null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()));
  const mutation = useMutation({
    mutationFn: async () => {
      const stableRequestId = requestId || crypto.randomUUID();
      setRequestId(stableRequestId);
      const common = {
        mode,
        fullName: form.fullName,
        phone: form.phone,
        employeeId: form.employeeId,
        roleId: form.roleId,
        dataScope: form.dataScope,
        scopeBranchId: form.dataScope === 'ONE_BRANCH' ? form.scopeBranchId : null,
        selectedBranchIds: form.dataScope === 'SELECTED_BRANCHES' ? form.selectedBranchIds : [],
        teamIds: supportsTeams ? form.teamIds : [],
        active: form.active,
        mfaRequired: effectiveMfa,
        requestId: stableRequestId,
      };
      return record
        ? updateTenantUser({
            ...common,
            userId: record.id,
            expectedVersion: record.version,
          })
        : inviteTenantUser({ ...common, email: form.email });
    },
    onSuccess: () => {
      onSaved(record ? 'User access updated' : 'Secure invitation sent');
      onClose();
    },
  });

  const setScope = (value: UserDataScope) => {
    setRequestId('');
    setForm((current) => ({
      ...current,
      dataScope: value,
      scopeBranchId:
        value === 'ONE_BRANCH' ? current.scopeBranchId || options.branches[0]?.id || '' : '',
      selectedBranchIds: value === 'SELECTED_BRANCHES' ? current.selectedBranchIds : [],
      teamIds: ['OWN_RECORDS', 'OWN_TEAM'].includes(value) ? current.teamIds : [],
    }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {record
              ? mode === 'CLIENT_ADMIN_BOOTSTRAP'
                ? 'Manage Client Admin'
                : 'Edit tenant user'
              : mode === 'CLIENT_ADMIN_BOOTSTRAP'
                ? 'Invite Client Admin'
                : 'Invite tenant user'}
          </DialogTitle>
          <DialogDescription>
            Role, permission and branch scope cannot exceed your current delegation ceiling.
            Deactivation retains the profile, assignments and audit history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) mutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Full name
              <Input
                value={form.fullName}
                onChange={(event) => {
                  setRequestId('');
                  setForm((current) => ({ ...current, fullName: event.target.value }));
                }}
                minLength={2}
                maxLength={160}
                required
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Email
              <Input
                type="email"
                value={form.email}
                onChange={(event) => {
                  setRequestId('');
                  setForm((current) => ({ ...current, email: event.target.value }));
                }}
                disabled={Boolean(record)}
                maxLength={254}
                required={!record}
              />
              {record && (
                <span className="text-xs font-normal text-muted-foreground">
                  Auth email changes require a separate verified identity workflow.
                </span>
              )}
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Phone
              <Input
                value={form.phone}
                onChange={(event) => {
                  setRequestId('');
                  setForm((current) => ({ ...current, phone: event.target.value }));
                }}
                maxLength={32}
                placeholder="+91 98765 43210"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Employee ID
              <Input
                value={form.employeeId}
                onChange={(event) => {
                  setRequestId('');
                  setForm((current) => ({ ...current, employeeId: event.target.value }));
                }}
                maxLength={64}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Role
              <Select
                value={form.roleId}
                onValueChange={(value) => {
                  const role = options.roles.find((option) => option.id === value);
                  setRequestId('');
                  setForm((current) => ({
                    ...current,
                    roleId: value,
                    teamIds: [],
                    mfaRequired: current.mfaRequired || Boolean(role?.mfa_required),
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {options.roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Data scope
              <Select
                value={form.dataScope}
                onValueChange={(value) => setScope(value as UserDataScope)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableScopes.map((scope) => (
                    <SelectItem key={scope.value} value={scope.value}>
                      {scope.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {form.dataScope === 'ONE_BRANCH' && (
            <label className="grid gap-1.5 text-sm font-medium">
              Assigned branch
              <Select
                value={form.scopeBranchId}
                onValueChange={(value) => {
                  setRequestId('');
                  setForm((current) => ({ ...current, scopeBranchId: value, teamIds: [] }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {options.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {form.dataScope === 'SELECTED_BRANCHES' && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Selected branches</p>
              <div className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
                {options.branches.map((branch) => {
                  const selected = form.selectedBranchIds.includes(branch.id);
                  return (
                    <Button
                      key={branch.id}
                      type="button"
                      variant={selected ? 'secondary' : 'outline'}
                      aria-pressed={selected}
                      className="justify-start"
                      onClick={() => {
                        setRequestId('');
                        setForm((current) => ({
                          ...current,
                          selectedBranchIds: selected
                            ? current.selectedBranchIds.filter((id) => id !== branch.id)
                            : [...current.selectedBranchIds, branch.id],
                          teamIds: current.teamIds.filter(
                            (id) =>
                              options.teams.find((team) => team.id === id)?.branch_id !== branch.id,
                          ),
                        }));
                      }}
                    >
                      {branch.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {supportsTeams && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Team membership
                {['OWN_RECORDS', 'OWN_TEAM'].includes(form.dataScope)
                  ? ' (required)'
                  : ' (optional)'}
              </p>
              <div className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
                {visibleTeams.length === 0 && (
                  <p className="text-sm text-muted-foreground sm:col-span-2">
                    No active team is available in the selected branch scope.
                  </p>
                )}
                {visibleTeams.map((team) => {
                  const selected = form.teamIds.includes(team.id);
                  return (
                    <Button
                      key={team.id}
                      type="button"
                      variant={selected ? 'secondary' : 'outline'}
                      aria-pressed={selected}
                      className="justify-start"
                      onClick={() => {
                        setRequestId('');
                        setForm((current) => ({
                          ...current,
                          teamIds: selected
                            ? current.teamIds.filter((id) => id !== team.id)
                            : [...current.teamIds, team.id],
                        }));
                      }}
                    >
                      {team.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              type="button"
              variant={form.active ? 'secondary' : 'destructive'}
              aria-pressed={form.active}
              onClick={() => {
                setRequestId('');
                setForm((current) => ({ ...current, active: !current.active }));
              }}
            >
              {form.active ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
              {form.active ? 'Account active' : 'Account inactive'}
            </Button>
            <Button
              type="button"
              variant={effectiveMfa ? 'secondary' : 'outline'}
              aria-pressed={effectiveMfa}
              disabled={Boolean(selectedRole?.mfa_required)}
              onClick={() => {
                setRequestId('');
                setForm((current) => ({ ...current, mfaRequired: !current.mfaRequired }));
              }}
            >
              <ShieldCheck className="size-4" />
              {effectiveMfa ? 'TOTP MFA required' : 'Require TOTP MFA'}
            </Button>
          </div>
          {!form.active && (
            <Alert variant="destructive">
              <AlertTitle>CRM access will be blocked</AlertTitle>
              <AlertDescription>
                The Auth identity and tenant history remain retained. Reactivation is available from
                this workspace.
              </AlertDescription>
            </Alert>
          )}
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertTitle>
                {mutation.error instanceof UserAdministrationError &&
                mutation.error.code === 'STALE_USER_VERSION'
                  ? 'This user changed in another session'
                  : 'User change not saved'}
              </AlertTitle>
              <AlertDescription>
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Review the role and scope values, then try again.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending ? 'Saving…' : record ? 'Save user' : 'Send secure invite'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserTable({
  data,
  options,
  query,
  isFetching,
  onQueryChange,
  onEdit,
}: {
  data: UserWorkspaceResult;
  options: UserAdministrationOptions | undefined;
  query: UserWorkspaceQuery;
  isFetching: boolean;
  onQueryChange: (next: Partial<UserWorkspaceQuery>) => void;
  onEdit: (record: UserAdministrationRecord) => void;
}) {
  const columns = useMemo<ColumnDef<UserAdministrationRecord>[]>(
    () => [
      {
        accessorKey: 'full_name',
        header: 'User',
        cell: ({ row }) => (
          <div className="flex min-w-52 items-center gap-3">
            <Avatar className="size-9">
              <AvatarFallback>{initials(row.original.full_name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{row.original.full_name}</p>
              <p className="text-xs text-muted-foreground">{row.original.email}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'role_name',
        header: 'Role',
        cell: ({ row }) => (
          <div>
            <p>{row.original.role_name}</p>
            <p className="text-xs text-muted-foreground">Level {row.original.authority_level}</p>
          </div>
        ),
      },
      {
        accessorKey: 'data_scope',
        header: 'Data scope',
        cell: ({ row }) => <Badge variant="outline">{scopeLabels[row.original.data_scope]}</Badge>,
      },
      {
        id: 'access',
        header: 'Branch / team access',
        cell: ({ row }) => (
          <div className="max-w-60">
            <p className="truncate text-sm">
              {row.original.data_scope === 'ORGANIZATION' ||
              row.original.data_scope === 'ALL_BRANCHES'
                ? 'All authorized branches'
                : row.original.branches.map((branch) => branch.name).join(', ') || 'Scope-derived'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.teams.map((team) => team.name).join(', ') || 'No team membership'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'active',
        header: 'Status',
        cell: ({ row }) => (
          <Badge variant={row.original.active ? 'success' : 'destructive'}>
            {row.original.active ? 'Active' : 'Inactive'}
          </Badge>
        ),
      },
      {
        accessorKey: 'mfa_required',
        header: 'MFA',
        cell: ({ row }) => (
          <Badge variant={row.original.mfa_required ? 'secondary' : 'outline'}>
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
        id: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onEdit(row.original)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
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
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={160}
              placeholder="Name, email, phone or employee ID"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(value) =>
                onQueryChange({ status: value as UserStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[145px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.roleId || 'all'}
              onValueChange={(value) =>
                onQueryChange({ roleId: value === 'all' ? '' : value, page: 1 })
              }
            >
              <SelectTrigger className="w-[175px]">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {options?.roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.branchId || 'all'}
              onValueChange={(value) =>
                onQueryChange({ branchId: value === 'all' ? '' : value, page: 1 })
              }
            >
              <SelectTrigger className="w-[175px]">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {options?.branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                onQueryChange({ sort: value as UserWorkspaceQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[155px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created-desc">Newest</SelectItem>
                <SelectItem value="updated-desc">Recently updated</SelectItem>
                <SelectItem value="name-asc">Name A–Z</SelectItem>
                <SelectItem value="role-asc">Role A–Z</SelectItem>
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
                    <p className="font-medium">No user matches this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Change the page-local search or filters.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Page {query.page} of {pages} · {data.total.toLocaleString()} results
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="w-[90px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
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

export function UserWorkspace({ spec, mode }: { spec: PageSpec; mode: UserAdministrationMode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParameters = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<UserWorkspaceQuery>(() =>
    parseUserWorkspaceQuery(searchParameters),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<UserAdministrationRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const effectiveQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const workspace = useQuery({
    queryKey: ['tenant-user-administration', mode, effectiveQuery],
    queryFn: () => fetchUserWorkspace(effectiveQuery, mode),
    placeholderData: keepPreviousData,
  });
  const options = useQuery({
    queryKey: ['tenant-user-administration-options', mode],
    queryFn: () => fetchUserAdministrationOptions(mode),
  });
  const changeQuery = useCallback(
    (next: Partial<UserWorkspaceQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toUserWorkspaceQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );
  const refresh = useCallback(
    (nextMessage: string) => {
      setMessage(nextMessage);
      void queryClient.invalidateQueries({ queryKey: ['tenant-user-administration'] });
      void queryClient.invalidateQueries({ queryKey: ['tenant-user-administration-options'] });
      void queryClient.invalidateQueries({ queryKey: ['role-administration'] });
    },
    [queryClient],
  );

  if (workspace.isPending) return <PageSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">User administration is unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              A current MFA session and the required tenant authority are needed.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <UserRealtimeBridge organizationId={workspace.data.organization_id} />
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <div className="shrink-0 sm:pt-7">
          <Button
            disabled={!options.data || options.data.roles.length === 0}
            onClick={() => {
              setEditRecord(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-4" />
            {mode === 'CLIENT_ADMIN_BOOTSTRAP' ? 'Invite Client Admin' : 'Invite user'}
          </Button>
        </div>
      </div>
      {message && (
        <Alert variant="success">
          <AlertTitle>{message}</AlertTitle>
          <AlertDescription>
            The scoped directory is refreshing from the audited server result.
          </AlertDescription>
        </Alert>
      )}
      {options.isError && (
        <Alert variant="destructive">
          <AlertTitle>Assignment options unavailable</AlertTitle>
          <AlertDescription>
            Invitations and edits are paused until roles, branches and teams can be loaded.
          </AlertDescription>
        </Alert>
      )}
      <KpiGrid metrics={metrics(workspace.data.kpis, mode)} />
      <UserTable
        data={workspace.data}
        options={options.data}
        query={query}
        isFetching={workspace.isFetching}
        onQueryChange={changeQuery}
        onEdit={(record) => {
          setEditRecord(record);
          setEditorOpen(true);
        }}
      />
      {editorOpen && options.data && (
        <UserEditorDialog
          key={editRecord?.id ?? 'new-user'}
          record={editRecord}
          mode={mode}
          options={options.data}
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
