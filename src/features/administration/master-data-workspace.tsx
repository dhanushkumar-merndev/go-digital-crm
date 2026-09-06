'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CarFront, Database, Filter, Plus, Search, Tag, ToggleLeft } from 'lucide-react';
import { useState } from 'react';
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
  upsertMasterModel,
  upsertMasterVariant,
  type MasterDataCategory,
} from './master-data-workspace-api';

const categories: Array<{ value: MasterDataCategory; label: string }> = [
  { value: 'MODELS', label: 'Models' },
  { value: 'VARIANTS', label: 'Variants' },
  { value: 'BRANDS', label: 'Brands' },
  { value: 'LEAD_SOURCES', label: 'Lead sources' },
];

export function MasterDataWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [category, setCategory] = useState<MasterDataCategory>('MODELS');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Form State for Model / Variant creation
  const [nameInput, setNameInput] = useState('');
  const [selectedParentId, setSelectedParentId] = useState('');
  const [fuelType, setFuelType] = useState('PETROL');
  const [transmission, setTransmission] = useState('MANUAL');

  const client = useQueryClient();
  const data = useQuery({
    queryKey: ['master-data', ...workspaceQueryScope(session), category, page, search],
    queryFn: ({ signal }) => fetchMasterDataWorkspace(category, page, search, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // Query brands when creating a model
  const brandsQuery = useQuery({
    queryKey: ['master-data-brands-list', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchMasterDataWorkspace('BRANDS', 1, '', signal),
    enabled: isAddOpen && category === 'MODELS',
    staleTime: 60_000,
  });

  // Query models when creating a variant
  const modelsQuery = useQuery({
    queryKey: ['master-data-models-list', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchMasterDataWorkspace('MODELS', 1, '', signal),
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
      if (category === 'MODELS') {
        return upsertMasterModel({
          brandId: selectedParentId,
          name: nameInput,
        });
      }
      if (category === 'VARIANTS') {
        return upsertMasterVariant({
          modelId: selectedParentId,
          name: nameInput,
          specifications: { fuel_type: fuelType, transmission },
        });
      }
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: `${category === 'MODELS' ? 'Model' : 'Variant'} created`,
        description: `${nameInput} has been added to vehicle master records.`,
      });
      setIsAddOpen(false);
      setNameInput('');
      setSelectedParentId('');
      client.invalidateQueries({ queryKey: ['master-data'] });
    },
    onError: (err: unknown) => {
      toast.add({
        type: 'error',
        title: 'Creation failed',
        description: err instanceof Error ? err.message : 'Please check your input values.',
      });
    },
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
                {(category === 'MODELS' || category === 'VARIANTS') && (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      setNameInput('');
                      setSelectedParentId('');
                      setIsAddOpen(true);
                    }}
                  >
                    <Plus className="size-4" /> Add {category === 'MODELS' ? 'Model' : 'Variant'}
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
                  data.data.records.map((row) => (
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
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={toggle.isPending}
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
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Add New {category === 'MODELS' ? 'Vehicle Model' : 'Vehicle Variant'}
            </DialogTitle>
            <DialogDescription>
              Add a new record to the vehicle catalog for inventory and quotation assignment.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="space-y-4 py-2"
          >
            {category === 'MODELS' ? (
              <div className="space-y-2">
                <Label htmlFor="model-brand">Select Brand</Label>
                <Select value={selectedParentId} onValueChange={setSelectedParentId} required>
                  <SelectTrigger id="model-brand">
                    <SelectValue placeholder="Choose manufacturer brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brandsQuery.data?.records.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="variant-model">Select Vehicle Model</Label>
                <Select value={selectedParentId} onValueChange={setSelectedParentId} required>
                  <SelectTrigger id="variant-model">
                    <SelectValue placeholder="Choose vehicle model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsQuery.data?.records.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name} ({m.brand_name})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="master-name">
                {category === 'MODELS' ? 'Model Name' : 'Variant Name'}
              </Label>
              <Input
                id="master-name"
                required
                placeholder={
                  category === 'MODELS' ? 'e.g. Elevate, City, Creta' : 'e.g. ZX CVT, SX(O) Turbo'
                }
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

            <DialogFooter className="pt-3">
              <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!selectedParentId || !nameInput.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? 'Adding...' : 'Add Record'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
