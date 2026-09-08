'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { CarFront, Target, TrendingUp, Pencil } from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { TenantTargetConfigurationSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import type { PageSpec } from '@/lib/domain';
import {
  fetchTenantTargetConfiguration,
  saveBranchTargetConfiguration,
  type ModelTarget,
} from './tenant-target-configuration-api';

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return (
    parts.find((p) => p.type === 'year')!.value + '-' + parts.find((p) => p.type === 'month')!.value
  );
}
const column = createColumnHelper<ModelTarget>();

export function TenantTargetConfigurationWorkspace({
  spec,
  readOnly = false,
}: {
  spec: PageSpec;
  readOnly?: boolean;
}) {
  const session = useWorkspaceSession();
  const [month, setMonth] = useState(currentMonth);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const [selected, setSelected] = useState<{
    model: ModelTarget;
    branchId: string;
    month: string;
  } | null>(null);
  const [units, setUnits] = useState('');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [
      'tenant-target-configuration',
      ...workspaceQueryScope(session),
      month,
      branchId,
      debouncedSearch,
      page,
      pageSize,
    ],
    queryFn: ({ signal }) =>
      fetchTenantTargetConfiguration({
        month,
        branchId,
        search: debouncedSearch,
        page,
        pageSize,
        signal,
      }),
    staleTime: 60000,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('TARGET_REQUIRED');
      return saveBranchTargetConfiguration({
        branchId: selected.branchId,
        month: selected.month,
        modelId: selected.model.id,
        units: Number(units),
        updatedAt: selected.model.updated_at,
      });
    },
    onSuccess: async () => {
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ['tenant-target-configuration'] });
      toast.add({ type: 'success', title: 'Model target saved' });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tenant-target-configuration'] });
      toast.add({
        type: 'error',
        title: 'Target was not saved',
        description: 'Close and reopen the model to load its latest target, then try again.',
      });
    },
  });
  const columns = [
    column.accessor('name', {
      header: 'Model',
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.name}
          {!row.original.active && (
            <Badge className="ml-2" variant="secondary">
              Inactive
            </Badge>
          )}
        </span>
      ),
    }),
    column.accessor('target_units', { header: 'Target units' }),
    column.accessor('booked_units', { header: 'Booked units' }),
    column.display({
      id: 'remaining',
      header: 'Remaining units',
      cell: ({ row }) => Math.max(0, row.original.target_units - row.original.booked_units),
    }),
    column.display({
      id: 'attainment',
      header: 'Achievement',
      cell: ({ row: { original: m } }) => (
        <Badge
          variant={m.target_units > 0 && m.booked_units >= m.target_units ? 'success' : 'outline'}
        >
          {m.target_units
            ? ((m.booked_units / m.target_units) * 100).toFixed(1) + '%'
            : 'No target'}
        </Badge>
      ),
    }),
    ...(!readOnly
      ? [
          column.display({
            id: 'action',
            header: 'Action',
            cell: ({ row }) => (
              <Button
                size="sm"
                variant="outline"
                disabled={!query.data?.branch_id}
                onClick={() => {
                  if (!query.data?.branch_id) return;
                  setSelected({ model: row.original, branchId: query.data.branch_id, month });
                  setUnits(String(row.original.target_units));
                }}
              >
                <Pencil className="size-3.5" /> Edit target
              </Button>
            ),
          }),
        ]
      : []),
  ];
  // TanStack Table exposes an imperative model, so React Compiler skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: query.data?.records ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  });
  const data = query.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            {readOnly
              ? 'Business Owner › Targets & performance'
              : 'Administration › Target configuration'}
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monthly vehicle targets by model. Each non-cancelled booking counts as one unit.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Select
            value={branchId ?? data?.branch_id ?? undefined}
            onValueChange={(value) => {
              setBranchId(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-64" aria-label="Target branch">
              <SelectValue placeholder="Select branch" />
            </SelectTrigger>
            <SelectContent>
              {data?.branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Target month"
            className="w-44"
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value || currentMonth());
              setPage(1);
            }}
          />
        </div>
      </div>
      {query.isPending ? (
        <TenantTargetConfigurationSkeleton />
      ) : query.isError || !data ? (
        <Card>
          <CardContent className="p-6">
            <p>Model targets could not be loaded.</p>
            <Button className="mt-3" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <KpiGrid
            className="xl:grid-cols-3"
            metrics={[
              {
                label: 'Target units',
                value: data.target_units.toLocaleString(),
                helper: 'All models in the selected branch',
                icon: Target,
                tone: 'bg-blue-50 text-blue-600',
              },
              {
                label: 'Booked units',
                value: data.booked_units.toLocaleString(),
                helper: 'Selected month · matched models',
                icon: CarFront,
                tone: 'bg-emerald-50 text-emerald-600',
              },
              {
                label: 'Achievement',
                value: data.target_units
                  ? ((data.booked_units / data.target_units) * 100).toFixed(1) + '%'
                  : 'No target',
                helper: 'Booked units / target units',
                icon: TrendingUp,
                tone: 'bg-violet-50 text-violet-600',
              },
            ]}
          />
          {data.unmatched_units > 0 && (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              {data.unmatched_units} booking(s) have no unambiguous vehicle model and are excluded.
              Check their quotation or stock allocation.
            </p>
          )}
        </>
      )}
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle>Model targets</CardTitle>
          <CardDescription>
            {readOnly ? 'View' : 'Set'} quantities per model for the selected branch and month. Zero
            means no target.
          </CardDescription>
          <Input
            className="max-w-sm"
            aria-label="Search models"
            placeholder="Search brand or model…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
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
              {!query.isPending && !query.isError && !data?.records.length && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No models found. Add vehicle models in CRM Configuration.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t p-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || query.isFetching}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} · {data?.total ?? 0} models
            </span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) as 25 | 50 | 100);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-28" aria-label="Models per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || page * pageSize >= data.total || query.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
      {!readOnly && (
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open && !save.isPending) setSelected(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set model target</DialogTitle>
              <DialogDescription>
                {selected?.model.name} · {selected?.month}
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="model-target-units">Target quantity (vehicles)</Label>
                <Input
                  id="model-target-units"
                  type="number"
                  min="0"
                  max={selected?.model.active ? 1000000 : 0}
                  step="1"
                  required
                  value={units}
                  onChange={(event) => setUnits(event.target.value)}
                />
                {selected && !selected.model.active && (
                  <p className="text-sm text-muted-foreground">
                    This model is inactive. You can clear its target by setting it to zero.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => setSelected(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    save.isPending ||
                    !units.trim() ||
                    !Number.isInteger(Number(units)) ||
                    Number(units) < 0 ||
                    Number(units) > 1000000
                  }
                >
                  Save targets
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
