'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchSelect } from '@/components/ui/search-select';
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
import { CatalogSharingCard } from './catalog-sharing-card';
import { ComparisonAiCard } from './comparison-ai-card';
import {
  fetchVehicleComparison,
  searchComparisonVehicles,
  type ComparisonVehicle,
} from './competitor-comparison-api';

function VehicleSelector({
  ownOnly,
  value,
  onChange,
}: {
  ownOnly: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const session = useWorkspaceSession();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(search, 300);
  const query = useQuery({
    queryKey: ['comparison-vehicles', ...workspaceQueryScope(session), ownOnly, term, page],
    queryFn: ({ signal }) => searchComparisonVehicles(term, ownOnly, page, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{ownOnly ? 'Our vehicle' : 'Compare with'}</p>
      <SearchSelect
        aria-label={ownOnly ? 'Our vehicle' : 'Compare with'}
        value={value}
        onValueChange={onChange}
        search={search}
        onSearchChange={(next) => {
          setSearch(next);
          setPage(1);
        }}
        options={query.data?.records.map((row) => ({
          value: row.id,
          label: row.manufacturer + ' ' + row.model + ' · ' + row.variant,
          description:
            row.dealership_name + (row.is_own ? ' · Your dealership' : ' · Dealer-provided'),
        }))}
        isPending={query.isPending}
        isFetching={query.isFetching}
        isError={query.isError}
        placeholder="Select a model / variant"
        searchPlaceholder="Search company, model or dealership"
        emptyMessage="No accessible models found."
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{query.data ? query.data.total + ' variants' : 'Loading variants…'}</span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 1 || query.isFetching}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!query.data || page * 25 >= query.data.total || query.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
function display(value: unknown, key?: string) {
  if (value === null || value === undefined || value === '') return 'Not specified';
  if (value === false || value === 'NOT_AVAILABLE') return 'Not available';
  if (key === 'ex_showroom_price' && typeof value === 'number')
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
type SpecRow = { name: string; ours: string; other: string };
const column = createColumnHelper<SpecRow>();
function SpecificationTable({
  ours,
  other,
}: {
  ours: ComparisonVehicle;
  other: ComparisonVehicle;
}) {
  const data = useMemo(
    () =>
      Array.from(
        new Set([...Object.keys(ours.specifications), ...Object.keys(other.specifications)]),
      )
        .sort()
        .map((key) => ({
          name: key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
          ours: display(ours.specifications[key], key),
          other: display(other.specifications[key], key),
        })),
    [ours, other],
  );
  const columns = useMemo(
    () => [
      column.accessor('name', { header: 'Specification' }),
      column.accessor('ours', {
        header: () => (
          <div>
            {ours.manufacturer} {ours.model} · {ours.variant}
            <p className="mt-1 text-xs font-normal">{ours.dealership_name} · Our vehicle</p>
          </div>
        ),
      }),
      column.accessor('other', {
        header: () => (
          <div>
            {other.manufacturer} {other.model} · {other.variant}
            <p className="mt-1 text-xs font-normal">
              {other.dealership_name} · {other.is_own ? 'Our vehicle' : 'Shared vehicle'}
            </p>
          </div>
        ),
      }),
    ],
    [ours, other],
  );
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle className="text-base">
          Specification comparison <Badge variant="secondary">Dealer-provided</Badge>
        </CardTitle>
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
            {!data.length ? (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center">
                  No specifications recorded. Ask your administrator to update vehicle variants.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
export function CompetitorComparisonWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [ourId, setOurId] = useState('');
  const [otherId, setOtherId] = useState('');
  const query = useQuery({
    queryKey: ['vehicle-comparison', ...workspaceQueryScope(session), ourId, otherId],
    queryFn: ({ signal }) => fetchVehicleComparison(ourId, otherId, signal),
    enabled: Boolean(ourId && otherId),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{spec.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Compare dealership-provided specifications. Missing information is not proof a feature is
          absent.
        </p>
      </div>
      <CatalogSharingCard />
      <Card className="shadow-none">
        <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto_1fr]">
          <VehicleSelector ownOnly value={ourId} onChange={setOurId} />
          <span className="self-center justify-self-center rounded-full bg-blue-50 p-3 text-sm font-semibold text-primary">
            VS
          </span>
          <VehicleSelector ownOnly={false} value={otherId} onChange={setOtherId} />
        </CardContent>
      </Card>
      {query.isError ? (
        <Card>
          <CardContent className="space-y-3 p-6 text-sm">
            <p>
              Comparison unavailable. A dealership may have withdrawn sharing or deactivated this
              model.
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : query.data ? (
        <>
          <SpecificationTable ours={query.data.ours} other={query.data.other} />
          <ComparisonAiCard key={JSON.stringify(query.data)} ourId={ourId} otherId={otherId} />
        </>
      ) : (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            {ourId && otherId ? 'Loading comparison…' : 'Select two vehicles to compare.'}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
