'use client';

import { TablePagination } from '@/components/shared/table-pagination';
import { ErrorState } from '@/components/shared/page-states';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KeyRound, Search, ShieldCheck, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { PlatformUserAccessSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import type { PageSpec } from '@/lib/domain';
import { fetchPlatformUserAccess } from './platform-user-access-api';

export function PlatformUserAccessWorkspace({ spec }: { spec: PageSpec }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const debouncedSearch = useDebouncedValue(search, 300);
  const query = useQuery({
    queryKey: ['platform-user-access', debouncedSearch, status, page, pageSize],
    queryFn: ({ signal }) =>
      fetchPlatformUserAccess({ search: debouncedSearch, status, page, pageSize }, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  if (query.isPending) return <PlatformUserAccessSkeleton />;
  if (query.isError || !query.data)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="Platform user access is unavailable"
          description="This view requires an MFA-assured Super Admin session."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  const data = query.data;
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined, readOnly: true }} />
      <KpiGrid
        className="xl:grid-cols-4"
        metrics={[
          {
            label: 'Users',
            value: data.kpis.total.toLocaleString('en-IN'),
            helper: 'Filtered platform view',
            icon: UsersRound,
          },
          {
            label: 'Active',
            value: data.kpis.active.toLocaleString('en-IN'),
            helper: 'Current active profiles',
            icon: ShieldCheck,
          },
          {
            label: 'MFA required',
            value: data.kpis.mfa_required.toLocaleString('en-IN'),
            helper: 'Profile policy flag',
            icon: KeyRound,
          },
          {
            label: 'Organizations',
            value: data.kpis.organizations.toLocaleString('en-IN'),
            helper: 'Tenants with matching users',
            icon: UsersRound,
          },
        ]}
      />
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b p-4">
          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-0 flex-1 md:max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                maxLength={160}
                placeholder="Name, email, employee ID, tenant…"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as typeof status);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All users</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) as typeof pageSize);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} rows
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Roles & scope</TableHead>
                <TableHead>Branch access</TableHead>
                <TableHead>MFA</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.records.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <p className="font-medium">{user.full_name}</p>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </TableCell>
                  <TableCell>{user.organization_name}</TableCell>
                  <TableCell className="max-w-72">
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((role) => (
                        <Badge key={`${role.key}:${role.scope}`} variant="outline">
                          {role.name} · {role.scope.replaceAll('_', ' ')}
                        </Badge>
                      ))}
                      {!user.roles.length ? (
                        <span className="text-xs text-muted-foreground">No active role</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{user.branch_count || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={user.mfa_required ? 'success' : 'outline'}>
                      {user.mfa_required ? 'Required' : 'Optional'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.active ? 'success' : 'secondary'}>
                      {user.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {!data.records.length ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No users match the current platform filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </Card>
    </div>
  );
}
