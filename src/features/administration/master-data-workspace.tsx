'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CarFront, Database, Filter, Search, Tag, ToggleLeft } from 'lucide-react';
import { useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchMasterDataWorkspace,
  setMasterDataActive,
  type MasterDataCategory,
} from './master-data-workspace-api';
const categories: Array<{ value: MasterDataCategory; label: string }> = [
  { value: 'MODELS', label: 'Models' },
  { value: 'BRANDS', label: 'Brands' },
  { value: 'LEAD_SOURCES', label: 'Lead sources' },
];
export function MasterDataWorkspace({ spec }: { spec: PageSpec }) {
  const [category, setCategory] = useState<MasterDataCategory>('MODELS');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const client = useQueryClient();
  const data = useQuery({
    queryKey: ['master-data', category, page, search],
    queryFn: ({ signal }) => fetchMasterDataWorkspace(category, page, search, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      setMasterDataActive(category, id, active),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Master data updated',
        description: 'The status change is recorded in the audit log.',
      });
      client.invalidateQueries({ queryKey: ['master-data'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Update failed',
        description: 'Check your administrator access and retry.',
      }),
  });
  if (data.isPending) return <PageSkeleton />;
  if (!data.data) return <div className="p-6 text-destructive">Master data is unavailable.</div>;
  const k = data.data.kpis;
  const metrics: Metric[] = [
    { label: 'Brands', value: String(k.brands), icon: CarFront },
    { label: 'Models', value: String(k.models), icon: CarFront },
    { label: 'Variants', value: String(k.variants), icon: Database },
    { label: 'Lead sources', value: String(k.lead_sources), icon: Tag },
  ];
  const pages = Math.max(1, Math.ceil(data.data.total / 25));
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <div className="grid gap-5 xl:grid-cols-[210px_minmax(0,1fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Master categories</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {categories.map((item) => (
              <Button
                key={item.value}
                className="w-full justify-start"
                variant={category === item.value ? 'secondary' : 'ghost'}
                onClick={() => {
                  setCategory(item.value);
                  setPage(1);
                }}
              >
                {item.label}
              </Button>
            ))}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <div className="flex flex-wrap gap-3">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder={`Search ${category.toLowerCase().replaceAll('_', ' ')}`}
                />
              </div>
              <Button variant="outline">
                <Filter /> Server filtered
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {category === 'MODELS' && <TableHead>Brand</TableHead>}
                  {category === 'LEAD_SOURCES' && <TableHead>Canonical source</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.records.length ? (
                  data.data.records.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      {category === 'MODELS' && <TableCell>{row.brand_name}</TableCell>}
                      {category === 'LEAD_SOURCES' && <TableCell>{row.canonical_source}</TableCell>}
                      <TableCell>
                        <StatusBadge value={row.active ? 'Active' : 'Inactive'} />
                      </TableCell>
                      <TableCell>
                        {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(
                          new Date(row.created_at),
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ id: row.id, active: !row.active })}
                        >
                          <ToggleLeft /> {row.active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No records found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
          <div className="flex justify-between border-t p-3 text-sm">
            <span>{data.data.total} records</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="self-center">
                {page} / {pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
