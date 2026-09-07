'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CarFront, Database, Filter, Pencil, Plus, Search, Tag, ToggleLeft } from 'lucide-react';
import { useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { MasterDataSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
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
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchMasterDataWorkspace,
  setMasterDataActive,
  saveVehicleMaster,
  type MasterDataCategory,
  type MasterDataRecord,
} from './master-data-workspace-api';

const categories: Array<{ value: MasterDataCategory; label: string }> = [
  { value: 'MODELS', label: 'Models' },
  { value: 'VARIANTS', label: 'Variants' },
  { value: 'COLOURS', label: 'Colours' },
  { value: 'BRANDS', label: 'Brands' },
  { value: 'LEAD_SOURCES', label: 'Lead sources' },
];

export function MasterDataWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [category, setCategory] = useState<MasterDataCategory>('MODELS');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<MasterDataRecord | null>(null);
  const [parentSearch, setParentSearch] = useState('');
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const debouncedSearch = useDebouncedValue(search, 300);
  const debouncedParentSearch = useDebouncedValue(parentSearch, 300);
  const [specifications, setSpecifications] = useState<Record<string, unknown>>({});

  // Form State for Model / Variant creation
  const [nameInput, setNameInput] = useState('');
  const [selectedParentId, setSelectedParentId] = useState('');
  const [fuelType, setFuelType] = useState('PETROL');
  const [transmission, setTransmission] = useState('MANUAL');

  const client = useQueryClient();
  const data = useQuery({
    queryKey: [
      'master-data',
      ...workspaceQueryScope(session),
      category,
      page,
      pageSize,
      debouncedSearch,
    ],
    queryFn: ({ signal }) =>
      fetchMasterDataWorkspace(category, page, debouncedSearch, signal, pageSize),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // Query brands when creating a model
  const brandsQuery = useQuery({
    queryKey: [
      'master-data',
      ...workspaceQueryScope(session),
      'brand-options',
      debouncedParentSearch,
    ],
    queryFn: ({ signal }) => fetchMasterDataWorkspace('BRANDS', 1, debouncedParentSearch, signal),
    enabled: isAddOpen && category === 'MODELS',
    staleTime: 60_000,
  });

  // Query models when creating a variant
  const modelsQuery = useQuery({
    queryKey: [
      'master-data',
      ...workspaceQueryScope(session),
      'model-options',
      debouncedParentSearch,
    ],
    queryFn: ({ signal }) => fetchMasterDataWorkspace('MODELS', 1, debouncedParentSearch, signal),
    enabled: isAddOpen && category === 'VARIANTS',
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
      client.invalidateQueries({ queryKey: ['vehicle-colour-options'] });
      client.invalidateQueries({ queryKey: ['inventory-variant-options'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Update failed',
        description: 'Check your administrator access and retry.',
      }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (category === 'LEAD_SOURCES') throw new Error('Select a vehicle category.');
      return saveVehicleMaster({
        category,
        id: editing?.id,
        parentId: selectedParentId,
        name: nameInput,
        active: editing?.active ?? true,
        specifications:
          category === 'VARIANTS' ? { ...specifications, fuel_type: fuelType, transmission } : {},
      });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Vehicle master saved',
        description: `${nameInput} has been ${editing ? 'updated' : 'added'}.`,
      });
      setIsAddOpen(false);
      setNameInput('');
      setSelectedParentId('');
      client.invalidateQueries({ queryKey: ['master-data'] });
      client.invalidateQueries({ queryKey: ['vehicle-colour-options'] });
      client.invalidateQueries({ queryKey: ['inventory-variant-options'] });
    },
    onError: (err: unknown) => {
      toast.add({
        type: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Please check your input values.',
      });
    },
  });

  const openEditor = (row: MasterDataRecord | null) => {
    setEditing(row);
    setNameInput(row?.name ?? '');
    setSelectedParentId(row?.brand_id ?? row?.model_id ?? '');
    setParentSearch('');
    setSpecifications(row?.specifications ?? {});
    setFuelType(String(row?.specifications?.fuel_type ?? 'PETROL'));
    setTransmission(String(row?.specifications?.transmission ?? 'MANUAL'));
    setIsAddOpen(true);
  };
  const parentQuery = category === 'MODELS' ? brandsQuery : modelsQuery;
  const parentOptions = (parentQuery.data?.records ?? []).map((row) => ({
    value: row.id,
    label: row.name,
    description: row.brand_name,
  }));
  const existingParentId = editing?.brand_id ?? editing?.model_id;
  if (existingParentId && !parentOptions.some((row) => row.value === existingParentId)) {
    parentOptions.unshift({
      value: existingParentId,
      label:
        editing?.brand_name && category === 'MODELS'
          ? editing.brand_name
          : (editing?.model_name ?? 'Current selection'),
      description: undefined,
    });
  }
  const needsParent = category === 'MODELS' || category === 'VARIANTS';
  const categoryLabel =
    category === 'MODELS'
      ? 'Model'
      : category === 'VARIANTS'
        ? 'Variant'
        : category === 'COLOURS'
          ? 'Colour'
          : 'Brand';

  const columns: ColumnDef<MasterDataRecord>[] = [
    { accessorKey: 'name' },
    ...(category === 'MODELS' ? [{ accessorKey: 'brand_name' }] : []),
    ...(category === 'VARIANTS'
      ? [{ accessorKey: 'model_name' }, { accessorKey: 'brand_name' }]
      : []),
    ...(category === 'LEAD_SOURCES' ? [{ accessorKey: 'canonical_source' }] : []),
    { accessorKey: 'active' },
    { accessorKey: 'created_at' },
    { id: 'actions' },
  ];
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data.data?.records ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: data.data?.total ?? 0,
    state: { pagination: { pageIndex: page - 1, pageSize } },
    getRowId: (row) => row.id,
  });

  if (data.isPending) return <MasterDataSkeleton />;
  if (!data.data) return <div className="p-6 text-destructive">Master data is unavailable.</div>;
  const k = data.data.kpis;
  const metrics: Metric[] = [
    { label: 'Brands', value: String(k.brands), icon: CarFront },
    { label: 'Models', value: String(k.models), icon: CarFront },
    { label: 'Variants', value: String(k.variants), icon: Database },
    { label: 'Lead sources', value: String(k.lead_sources), icon: Tag },
  ];
  const pages = Math.max(1, Math.ceil(data.data.total / pageSize));

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
            <div className="flex flex-wrap items-center justify-between gap-3">
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
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-9 gap-2 px-3 font-medium">
                  <Filter className="size-4" /> Server filtered
                </Badge>
                {category !== 'LEAD_SOURCES' && (
                  <Button size="sm" className="gap-1.5" onClick={() => openEditor(null)}>
                    <Plus className="size-4" /> Add {categoryLabel}
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {category === 'MODELS' && <TableHead>Brand</TableHead>}
                  {category === 'VARIANTS' && (
                    <>
                      <TableHead>Model</TableHead>
                      <TableHead>Brand</TableHead>
                    </>
                  )}
                  {category === 'LEAD_SOURCES' && <TableHead>Canonical source</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.records.length ? (
                  table.getRowModel().rows.map(({ original: row }) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      {category === 'MODELS' && <TableCell>{row.brand_name}</TableCell>}
                      {category === 'VARIANTS' && (
                        <>
                          <TableCell className="font-medium text-primary">
                            {row.model_name ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.brand_name ?? '—'}
                          </TableCell>
                        </>
                      )}
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
                        {category !== 'LEAD_SOURCES' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={toggle.isPending || data.isPlaceholderData}
                            onClick={() => openEditor(row)}
                          >
                            <Pencil className="mr-1 size-3.5" /> Edit
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={toggle.isPending || data.isPlaceholderData}
                          onClick={() => toggle.mutate({ id: row.id, active: !row.active })}
                        >
                          <ToggleLeft className="size-3.5 mr-1" />{' '}
                          {row.active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-muted-foreground"
                    >
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
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value) as 25 | 50 | 100);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-24" aria-label="Rows per page">
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
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="self-center text-xs text-muted-foreground">
                Page {page} of {pages}
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

      {/* Add Model / Variant Dialog */}
      <Dialog
        open={isAddOpen}
        onOpenChange={(open) => {
          if (!createMutation.isPending) setIsAddOpen(open);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Edit' : 'Add'} {categoryLabel}
            </DialogTitle>
            <DialogDescription>
              Manage the dealership vehicle catalog. Saved stock colours and sales document
              snapshots are preserved.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="space-y-4 py-2"
          >
            {needsParent && (
              <div className="space-y-2">
                <Label htmlFor="master-parent">
                  {category === 'MODELS' ? 'Brand' : 'Vehicle model'}
                </Label>
                <SearchSelect
                  key={`${category}-${editing?.id ?? 'new'}`}
                  id="master-parent"
                  value={selectedParentId}
                  onValueChange={setSelectedParentId}
                  options={parentOptions}
                  search={parentSearch}
                  onSearchChange={setParentSearch}
                  isPending={parentQuery.isPending}
                  isFetching={parentQuery.isFetching}
                  isError={parentQuery.isError}
                  placeholder={category === 'MODELS' ? 'Choose brand' : 'Choose model'}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="master-name">{categoryLabel} name</Label>
              <Input
                id="master-name"
                required
                maxLength={80}
                placeholder={category === 'COLOURS' ? 'e.g. Platinum White Pearl' : 'Name'}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
            </div>

            {category === 'VARIANTS' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="fuel-type">Fuel Type</Label>
                  <Select value={fuelType} onValueChange={setFuelType}>
                    <SelectTrigger id="fuel-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PETROL">Petrol</SelectItem>
                      <SelectItem value="DIESEL">Diesel</SelectItem>
                      <SelectItem value="ELECTRIC">Electric (EV)</SelectItem>
                      <SelectItem value="HYBRID">Strong Hybrid</SelectItem>
                      <SelectItem value="CNG">CNG</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trans-type">Transmission</Label>
                  <Select value={transmission} onValueChange={setTransmission}>
                    <SelectTrigger id="trans-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MANUAL">Manual</SelectItem>
                      <SelectItem value="AUTOMATIC">Automatic (AT)</SelectItem>
                      <SelectItem value="CVT">CVT</SelectItem>
                      <SelectItem value="DCT">DCT / DSG</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {category === 'VARIANTS' && (
              <div className="grid grid-cols-2 gap-4">
                {[
                  ['engine_cc', 'Engine capacity (cc)'],
                  ['max_power_bhp', 'Power (bhp)'],
                  ['mileage_kmpl', 'Mileage (km/l)'],
                  ['seating_capacity', 'Seats'],
                  ['range_km', 'EV range (km)'],
                  ['boot_space_litres', 'Boot space (litres)'],
                ].map(([key, label]) => (
                  <div className="space-y-2" key={key}>
                    <Label htmlFor={`spec-${key}`}>{label}</Label>
                    <Input
                      id={`spec-${key}`}
                      type="number"
                      min="0"
                      step="any"
                      value={String(specifications[key] ?? '')}
                      onChange={(event) =>
                        setSpecifications((current) => {
                          const next = { ...current };
                          if (event.target.value === '') delete next[key];
                          else next[key] = Number(event.target.value);
                          return next;
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}

            <DialogFooter className="pt-3">
              <Button
                type="button"
                variant="outline"
                disabled={createMutation.isPending}
                onClick={() => setIsAddOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  (needsParent && !selectedParentId) ||
                  !nameInput.trim() ||
                  createMutation.isPending
                }
              >
                {createMutation.isPending ? 'Saving…' : 'Save record'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
