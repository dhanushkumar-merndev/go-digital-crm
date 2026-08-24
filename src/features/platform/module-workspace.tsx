'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Blocks,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  PauseCircle,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { ModuleWorkspaceSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchPlatformModuleWorkspace,
  setPlatformModuleActive,
  type ModuleStatusFilter,
} from './module-workspace-api';

function requestId() {
  return globalThis.crypto.randomUUID();
}

export function ModuleWorkspace({ spec }: { spec: PageSpec }) {
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [status, setStatus] = useState<ModuleStatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['platform-module-workspace', page, search, status],
    queryFn: ({ signal }) => fetchPlatformModuleWorkspace({ page, search, status, signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const mutation = useMutation({
    mutationFn: setPlatformModuleActive,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: result.active ? 'Module enabled' : 'Module disabled',
        description: 'The platform catalog change was recorded in the audit log.',
      });
      queryClient.invalidateQueries({ queryKey: ['platform-module-workspace'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Module update failed',
        description:
          'Your platform MFA session may have expired. Please retry after signing in again.',
      }),
  });
  const result = query.data;
  const metrics: Metric[] = result
    ? [
        { label: 'Total modules', value: result.kpis.total_modules.toLocaleString(), icon: Blocks },
        {
          label: 'Active modules',
          value: result.kpis.active_modules.toLocaleString(),
          icon: CheckCircle2,
        },
        {
          label: 'Disabled modules',
          value: result.kpis.inactive_modules.toLocaleString(),
          icon: PauseCircle,
        },
        {
          label: 'Plan assignments',
          value: result.kpis.plan_assignments.toLocaleString(),
          icon: ShieldCheck,
        },
        { label: 'Enabled entitlements', value: result.kpis.enabled_entitlements.toLocaleString() },
      ]
    : [];
  const hasNext = Boolean(result && page * 25 < result.total);

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Platform › Catalog</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control platform module availability. Tenant entitlements and recent usage are read from
          the live platform catalog.
        </p>
      </div>
      {query.isPending ? <ModuleWorkspaceSkeleton /> : null}
      {result ? <KpiGrid metrics={metrics} className="xl:grid-cols-5" /> : null}
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setPage(1);
              }}
              className="pl-9"
              placeholder="Search module name or key"
              aria-label="Search modules"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as ModuleStatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="md:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All status</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="INACTIVE">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      {query.isError ? (
        <Card className="shadow-none">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Modules could not be loaded. Confirm Super Admin MFA access and deploy the platform
            module workspace migration.
          </CardContent>
        </Card>
      ) : null}
      {result ? (
        <>
          <Card className="overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Platform modules</CardTitle>
              <CardDescription>
                Each change is audited. Disabling a module does not delete tenant data.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Module</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Plans</TableHead>
                    <TableHead>Tenant entitlements</TableHead>
                    <TableHead>Usage · 30 days</TableHead>
                    <TableHead className="text-right">Availability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.records.map((module) => (
                    <TableRow key={module.id}>
                      <TableCell>
                        <p className="font-medium">{module.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {module.module_key}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={module.active ? 'success' : 'destructive'}>
                          {module.active ? 'Active' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell>{module.plan_count}</TableCell>
                      <TableCell>
                        {module.enabled_tenant_count} enabled{' '}
                        <span className="text-muted-foreground">
                          / {module.tenant_count} configured
                        </span>
                      </TableCell>
                      <TableCell>{module.usage_last_30_days.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant={module.active ? 'outline' : 'default'}
                          size="sm"
                          disabled={mutation.isPending}
                          onClick={() =>
                            mutation.mutate({
                              moduleId: module.id,
                              active: !module.active,
                              requestId: requestId(),
                            })
                          }
                        >
                          {module.active ? 'Disable' : 'Enable'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!result.records.length ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No platform modules match the selected server-side filters.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || query.isFetching}
              onClick={() => setPage((current) => current - 1)}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {page} · {result.total} modules
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || query.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
