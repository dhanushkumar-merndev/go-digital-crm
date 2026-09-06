'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Package,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
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
  fetchAccessoriesCatalog,
  upsertAccessory,
  type AccessoryCategory,
  type AccessoryRecord,
} from './accessories-api';

const categories: Array<{ value: AccessoryCategory | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All Categories' },
  { value: 'EXTERIOR', label: 'Exterior' },
  { value: 'INTERIOR', label: 'Interior' },
  { value: 'ELECTRICAL', label: 'Electrical' },
  { value: 'CAR_CARE', label: 'Car Care' },
  { value: 'SAFETY_UTILITY', label: 'Safety & Utility' },
];

export function AccessoriesWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [selectedCategory, setSelectedCategory] = useState<AccessoryCategory | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AccessoryRecord | null>(null);

  // Form State
  const [formName, setFormName] = useState('');
  const [formPartNumber, setFormPartNumber] = useState('');
  const [formCategory, setFormCategory] = useState<AccessoryCategory>('EXTERIOR');
  const [formPrice, setFormPrice] = useState('1500');
  const [formStock, setFormStock] = useState('10');
  const [formOem, setFormOem] = useState(true);

  const client = useQueryClient();
  const categoryParam = selectedCategory === 'ALL' ? null : selectedCategory;

  const catalogQuery = useQuery({
    queryKey: ['accessories-catalog', ...workspaceQueryScope(session), categoryParam, search, page],
    queryFn: ({ signal }) => fetchAccessoriesCatalog(categoryParam, search, page, 25, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      return upsertAccessory({
        id: editingItem?.id,
        name: formName,
        partNumber: formPartNumber,
        category: formCategory,
        price: Number.parseFloat(formPrice) || 0,
        stockQuantity: Number.parseInt(formStock, 10) || 0,
        oem: formOem,
      });
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: editingItem ? 'Accessory updated' : 'Accessory added',
        description: `${formName} has been saved to the dealership catalog.`,
      });
      setIsCreateOpen(false);
      setEditingItem(null);
      client.invalidateQueries({ queryKey: ['accessories-catalog'] });
    },
    onError: (err: unknown) => {
      toast.add({
        type: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Could not save accessory.',
      });
    },
  });

  function openCreateDialog() {
    setEditingItem(null);
    setFormName('');
    setFormPartNumber('');
    setFormCategory('EXTERIOR');
    setFormPrice('1500');
    setFormStock('10');
    setFormOem(true);
    setIsCreateOpen(true);
  }

  function openEditDialog(item: AccessoryRecord) {
    setEditingItem(item);
    setFormName(item.name);
    setFormPartNumber(item.part_number);
    setFormCategory(item.category);
    setFormPrice(String(item.price));
    setFormStock(String(item.stock_quantity));
    setFormOem(item.oem);
    setIsCreateOpen(true);
  }

  const kpis = catalogQuery.data?.kpis;
  const metrics: Metric[] = [
    { label: 'Catalog Items', value: String(kpis?.total_items ?? 0), icon: Package },
    { label: 'Active Items', value: String(kpis?.active_items ?? 0), icon: CheckCircle2 },
    { label: 'Low Stock Alert (≤3)', value: String(kpis?.low_stock ?? 0), icon: Box },
    { label: 'OEM Certified', value: '100%', icon: ShieldCheck },
  ];

  const totalPages = Math.max(1, Math.ceil((catalogQuery.data?.total ?? 0) / 25));

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />

      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />

      <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Categories</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {categories.map((cat) => (
              <Button
                key={cat.value}
                className="w-full justify-start text-xs font-medium"
                variant={selectedCategory === cat.value ? 'secondary' : 'ghost'}
                onClick={() => {
                  setSelectedCategory(cat.value);
                  setPage(1);
                }}
              >
                {cat.label}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative min-w-[280px] flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search accessory name or part number..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-9 gap-1.5 px-3">
                  <Filter className="size-3.5" />
                  {catalogQuery.data?.total ?? 0} items
                </Badge>
                <Button size="sm" onClick={openCreateDialog} className="gap-1.5">
                  <Plus className="size-4" /> Add Item
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Accessory Name</TableHead>
                  <TableHead>Part Number</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Price (₹)</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogQuery.data?.records.length ? (
                  catalogQuery.data.records.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="font-mono text-xs">{item.part_number}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {item.category.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold">
                        ₹{item.price.toLocaleString('en-IN')}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                            item.stock_quantity <= 3
                              ? 'bg-rose-50 text-rose-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {item.stock_quantity} in stock
                        </span>
                      </TableCell>
                      <TableCell>
                        {item.oem ? (
                          <Badge variant="secondary" className="bg-blue-50 text-blue-700">
                            OEM
                          </Badge>
                        ) : (
                          <Badge variant="outline">Aftermarket</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={item.active ? 'Active' : 'Inactive'} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => openEditDialog(item)}>
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      No accessories match your filter criteria.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add / Edit Accessory Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Accessory' : 'Add New Accessory'}</DialogTitle>
            <DialogDescription>
              Configure the accessory details, OEM part code, and stock inventory.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate();
            }}
            className="space-y-4 py-2"
          >
            <div className="space-y-2">
              <Label htmlFor="acc-name">Accessory Name</Label>
              <Input
                id="acc-name"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. 7D All-Weather Floor Mats"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="acc-part">Part Number / SKU</Label>
                <Input
                  id="acc-part"
                  required
                  value={formPartNumber}
                  onChange={(e) => setFormPartNumber(e.target.value)}
                  placeholder="e.g. OEM-MAT-7D"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-cat">Category</Label>
                <Select
                  value={formCategory}
                  onValueChange={(val) => setFormCategory(val as AccessoryCategory)}
                >
                  <SelectTrigger id="acc-cat">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EXTERIOR">Exterior</SelectItem>
                    <SelectItem value="INTERIOR">Interior</SelectItem>
                    <SelectItem value="ELECTRICAL">Electrical</SelectItem>
                    <SelectItem value="CAR_CARE">Car Care</SelectItem>
                    <SelectItem value="SAFETY_UTILITY">Safety & Utility</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="acc-price">Unit Price (₹)</Label>
                <Input
                  id="acc-price"
                  type="number"
                  required
                  min="0"
                  step="50"
                  value={formPrice}
                  onChange={(e) => setFormPrice(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-stock">Initial Stock Quantity</Label>
                <Input
                  id="acc-stock"
                  type="number"
                  required
                  min="0"
                  value={formStock}
                  onChange={(e) => setFormStock(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                type="checkbox"
                id="acc-oem"
                className="size-4 rounded border-gray-300"
                checked={formOem}
                onChange={(e) => setFormOem(e.target.checked)}
              />
              <Label htmlFor="acc-oem" className="cursor-pointer text-sm font-normal">
                OEM Certified Genuine Accessory
              </Label>
            </div>

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving...' : 'Save Accessory'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
