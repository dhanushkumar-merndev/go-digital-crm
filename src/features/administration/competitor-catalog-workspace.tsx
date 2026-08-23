'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CarFront, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  fetchCompetitorProfiles,
  saveCompetitorProfile,
  type CompetitorProfile,
} from './competitor-catalog-api';
const empty = {
  manufacturer: '',
  model: '',
  variant: '',
  fuelType: '',
  price: '',
  specifications: '{}',
  advantages: '',
};
export function CompetitorCatalogWorkspace({ spec }: { spec: PageSpec }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<CompetitorProfile | null | undefined>(undefined);
  const [form, setForm] = useState(empty);
  const query = useQuery({
    queryKey: ['competitor-catalog'],
    queryFn: ({ signal }) => fetchCompetitorProfiles(signal),
    staleTime: 60_000,
  });
  const open = (profile?: CompetitorProfile) => {
    setSelected(profile ?? null);
    setForm(
      profile
        ? {
            manufacturer: profile.manufacturer,
            model: profile.model,
            variant: profile.variant,
            fuelType: profile.fuel_type ?? '',
            price: profile.ex_showroom_price?.toString() ?? '',
            specifications: JSON.stringify(profile.specifications, null, 2),
            advantages: profile.advantages.join('\n'),
          }
        : empty,
    );
  };
  const save = useMutation({
    mutationFn: () => {
      let specifications: Record<string, unknown>;
      try {
        specifications = JSON.parse(form.specifications || '{}') as Record<string, unknown>;
      } catch {
        throw new Error('INVALID_SPECIFICATIONS');
      }
      return saveCompetitorProfile({
        id: selected?.id,
        manufacturer: form.manufacturer,
        model: form.model,
        variant: form.variant,
        fuelType: form.fuelType,
        price: form.price === '' ? null : Number(form.price),
        specifications,
        advantages: form.advantages
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        active: selected?.active ?? true,
        requestId: crypto.randomUUID(),
      });
    },
    onSuccess: async () => {
      setSelected(undefined);
      await queryClient.invalidateQueries({ queryKey: ['competitor-catalog'] });
      toast.add({
        type: 'success',
        title: 'Competitor profile saved',
        description: 'Sales comparison now uses this tenant-owned catalog data.',
      });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Profile was not saved',
        description: 'Check required fields and valid JSON specifications.',
      }),
  });
  if (query.isPending) return <PageSkeleton />;
  if (!query.data)
    return <div className="p-6 text-destructive">Competitor catalog is unavailable.</div>;
  const profiles = query.data;
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <KpiGrid
        className="xl:grid-cols-3"
        metrics={[
          { label: 'Profiles', value: String(profiles.length), icon: CarFront },
          {
            label: 'Active',
            value: String(profiles.filter((profile) => profile.active).length),
            icon: ShieldCheck,
          },
          { label: 'Scope', value: 'Tenant', helper: 'No shared competitor data', icon: CarFront },
        ]}
      />
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Competitor vehicle catalog</CardTitle>
          <Button onClick={() => open()}>
            <Plus className="size-4" /> Add profile
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Fuel</TableHead>
                <TableHead>Ex-showroom price</TableHead>
                <TableHead>Advantages</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.id}>
                  <TableCell className="font-medium">
                    {profile.manufacturer} {profile.model}
                    <p className="text-xs text-muted-foreground">{profile.variant}</p>
                  </TableCell>
                  <TableCell>{profile.fuel_type ?? '—'}</TableCell>
                  <TableCell>
                    {profile.ex_showroom_price
                      ? new Intl.NumberFormat('en-IN', {
                          style: 'currency',
                          currency: 'INR',
                          maximumFractionDigits: 0,
                        }).format(profile.ex_showroom_price)
                      : '—'}
                  </TableCell>
                  <TableCell>{profile.advantages.length}</TableCell>
                  <TableCell>
                    <Badge variant={profile.active ? 'success' : 'secondary'}>
                      {profile.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => open(profile)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!profiles.length ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Add a verified competitor profile before Sales Consultants use comparison.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        open={selected !== undefined}
        onOpenChange={(openState) => !openState && !save.isPending && setSelected(undefined)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selected ? 'Edit competitor profile' : 'Add competitor profile'}
            </DialogTitle>
            <DialogDescription>
              Enter verified manufacturer information only. Specifications must be a JSON object.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label>
              Manufacturer
              <Input
                value={form.manufacturer}
                onChange={(event) => setForm({ ...form, manufacturer: event.target.value })}
              />
            </Label>
            <Label>
              Model
              <Input
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              />
            </Label>
            <Label>
              Variant
              <Input
                value={form.variant}
                onChange={(event) => setForm({ ...form, variant: event.target.value })}
              />
            </Label>
            <Label>
              Fuel type
              <Input
                value={form.fuelType}
                onChange={(event) => setForm({ ...form, fuelType: event.target.value })}
              />
            </Label>
            <Label>
              Ex-showroom price
              <Input
                type="number"
                min="0"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })}
              />
            </Label>
            <Label>
              Specifications JSON
              <Textarea
                className="min-h-28 font-mono text-xs"
                value={form.specifications}
                onChange={(event) => setForm({ ...form, specifications: event.target.value })}
              />
            </Label>
            <Label>
              Advantages (one per line)
              <Textarea
                value={form.advantages}
                onChange={(event) => setForm({ ...form, advantages: event.target.value })}
              />
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(undefined)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Save profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
