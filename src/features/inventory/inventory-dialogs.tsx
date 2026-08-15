'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, PackageCheck, Pencil, Plus, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/shared/status-badge';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  allocateStockUnit,
  changeStockStatus,
  createStockUnit,
  fetchBookingOptions,
  fetchStockUnitDetail,
  fetchVariantOptions,
  moveStockUnit,
  releaseStockAllocation,
  updateStockUnit,
  type InventoryBranch,
  type InventoryPermissions,
} from './inventory-api';
import { isInventoryVersionConflict } from './inventory-query';

function toIsoOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? '').trim();
  return text ? new Date(text).toISOString() : null;
}

function mutationMessage(error: unknown) {
  return isInventoryVersionConflict(error)
    ? 'This inventory record changed elsewhere. Reload the detail before trying again.'
    : 'The inventory operation could not be completed. Check the values and your branch scope.';
}

export function StockIntakeDialog({
  organizationId,
  branches,
  open,
  initialReceivedAt,
  onOpenChange,
  onCreated,
}: {
  organizationId: string;
  branches: InventoryBranch[];
  open: boolean;
  initialReceivedAt: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [variantSearch, setVariantSearch] = useState('');
  const [variantId, setVariantId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<'INCOMING' | 'AVAILABLE'>('AVAILABLE');
  const debouncedVariantSearch = useDebouncedValue(variantSearch, 300);
  const requestId = useRef<string | null>(null);
  const variants = useQuery({
    queryKey: ['inventory-variant-options', organizationId, debouncedVariantSearch],
    queryFn: ({ signal }) => fetchVariantOptions(debouncedVariantSearch, signal),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const mutation = useMutation({
    mutationFn: createStockUnit,
    onSuccess: () => {
      requestId.current = null;
      onCreated();
      onOpenChange(false);
    },
  });

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      mutation.reset();
      requestId.current = null;
      setVariantSearch('');
      setVariantId('');
      setBranchId('');
      setStatus('AVAILABLE');
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Intake stock unit</DialogTitle>
          <DialogDescription>
            Register one physical vehicle. VIN and chassis identity cannot be silently reused.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!branchId || !variantId) return;
            const form = new FormData(event.currentTarget);
            requestId.current ??= globalThis.crypto.randomUUID();
            mutation.mutate({
              organizationId,
              branchId,
              variantId,
              vin: String(form.get('vin') ?? ''),
              chassisNumber: String(form.get('chassisNumber') ?? ''),
              engineNumber: String(form.get('engineNumber') ?? '').trim() || null,
              color: String(form.get('color') ?? '').trim() || null,
              status,
              receivedAt: toIsoOrNull(form.get('receivedAt')),
              requestId: requestId.current,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 text-sm font-medium">
              Branch
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select authorized branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 text-sm font-medium">
              Intake status
              <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AVAILABLE">Available</SelectItem>
                  <SelectItem value="INCOMING">Incoming</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Find vehicle variant
            <Input
              value={variantSearch}
              onChange={(event) => setVariantSearch(event.target.value)}
              maxLength={100}
              placeholder="Brand, model or variant…"
            />
          </label>
          <div className="grid gap-1.5 text-sm font-medium">
            Variant
            <Select value={variantId} onValueChange={setVariantId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={variants.isPending ? 'Loading variants…' : 'Select variant'}
                />
              </SelectTrigger>
              <SelectContent>
                {variants.data?.map((variant) => (
                  <SelectItem key={variant.id} value={variant.id}>
                    {variant.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              VIN
              <Input
                name="vin"
                required
                minLength={17}
                maxLength={17}
                autoCapitalize="characters"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Chassis number
              <Input name="chassisNumber" required minLength={6} maxLength={32} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Engine number <span className="font-normal text-muted-foreground">(optional)</span>
              <Input name="engineNumber" maxLength={32} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Colour <span className="font-normal text-muted-foreground">(optional)</span>
              <Input name="color" maxLength={80} />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium sm:max-w-xs">
            Received at
            <Input
              name="receivedAt"
              type="datetime-local"
              required={status === 'AVAILABLE'}
              defaultValue={initialReceivedAt}
            />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <div>
                <AlertTitle>Stock intake failed</AlertTitle>
                <AlertDescription>{mutationMessage(mutation.error)}</AlertDescription>
              </div>
            </Alert>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!branchId || !variantId || mutation.isPending}>
              <Plus className="size-4" /> {mutation.isPending ? 'Saving…' : 'Intake unit'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function nextStatuses(status: string) {
  const transitions: Record<string, string[]> = {
    INCOMING: ['AVAILABLE', 'HOLD'],
    AVAILABLE: ['HOLD'],
    HOLD: ['AVAILABLE'],
    ALLOCATED: ['READY_FOR_DELIVERY'],
    READY_FOR_DELIVERY: ['DELIVERED'],
  };
  return transitions[status] ?? [];
}

function OperationError({ error }: { error: unknown }) {
  return <p className="text-sm text-destructive">{mutationMessage(error)}</p>;
}

export function StockUnitDetailSheet({
  stockUnitId,
  branches,
  permissions,
  onOpenChange,
  onChanged,
}: {
  stockUnitId: string | null;
  branches: InventoryBranch[];
  permissions: InventoryPermissions;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const detail = useQuery({
    queryKey: ['inventory-unit-detail', stockUnitId],
    queryFn: () => fetchStockUnitDetail(stockUnitId as string),
    enabled: Boolean(stockUnitId),
  });
  const [status, setStatus] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [allocationStatus, setAllocationStatus] = useState<'RESERVED' | 'ALLOCATED'>('ALLOCATED');
  const debouncedBookingSearch = useDebouncedValue(bookingSearch, 300);
  const requestIds = useRef<Record<string, string>>({});
  const data = detail.data;
  const lifecycleOptions = data
    ? nextStatuses(data.status).filter(
        (nextStatus) => nextStatus !== 'AVAILABLE' || Boolean(data.received_at),
      )
    : [];
  const activeAllocation = data?.allocations.find((allocation) =>
    ['ACTIVE', 'PENDING', 'SUGGESTED', 'RESERVED', 'ALLOCATED', 'ON_HOLD'].includes(
      allocation.status,
    ),
  );
  const bookings = useQuery({
    queryKey: ['inventory-booking-options', data?.branch_id, debouncedBookingSearch],
    queryFn: ({ signal }) =>
      fetchBookingOptions(data?.branch_id as string, debouncedBookingSearch, signal),
    enabled: Boolean(data?.branch_id && permissions.canAllocate && data.status === 'AVAILABLE'),
    placeholderData: keepPreviousData,
  });
  const afterMutation = () => {
    requestIds.current = {};
    onChanged();
    void detail.refetch();
  };
  const updateMutation = useMutation({ mutationFn: updateStockUnit, onSuccess: afterMutation });
  const statusMutation = useMutation({ mutationFn: changeStockStatus, onSuccess: afterMutation });
  const moveMutation = useMutation({ mutationFn: moveStockUnit, onSuccess: afterMutation });
  const allocationMutation = useMutation({
    mutationFn: allocateStockUnit,
    onSuccess: afterMutation,
  });
  const releaseMutation = useMutation({
    mutationFn: releaseStockAllocation,
    onSuccess: afterMutation,
  });

  const requestId = (key: string) => {
    requestIds.current[key] ??= globalThis.crypto.randomUUID();
    return requestIds.current[key];
  };

  return (
    <Sheet
      open={Boolean(stockUnitId)}
      onOpenChange={(open) => {
        if (!open) {
          requestIds.current = {};
          setStatus('');
          setToBranchId('');
          setBookingSearch('');
          setBookingId('');
        }
        onOpenChange(open);
      }}
    >
      <SheetContent side="right" className="w-full max-w-3xl overflow-y-auto p-6 sm:w-[720px]">
        <SheetTitle>Stock unit detail</SheetTitle>
        <SheetDescription className="mt-1">
          Physical identity, allocation state and append-only movement history.
        </SheetDescription>
        {detail.isPending && <p className="mt-8 text-sm text-muted-foreground">Loading unit…</p>}
        {detail.isError && (
          <Alert variant="destructive" className="mt-6">
            <TriangleAlert className="size-4" />
            <div>
              <AlertTitle>Stock unit unavailable</AlertTitle>
              <AlertDescription>
                The unit may be outside your authorized branch scope.
              </AlertDescription>
            </div>
          </Alert>
        )}
        {data && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
              <div>
                <p className="text-lg font-semibold">{data.vin}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {data.brand_name} {data.model_name} · {data.variant_name}
                </p>
              </div>
              <StatusBadge value={data.status} />
            </div>
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Chassis:</span> {data.chassis_number}
              </div>
              <div>
                <span className="text-muted-foreground">Engine:</span> {data.engine_number ?? '—'}
              </div>
              <div>
                <span className="text-muted-foreground">Colour:</span> {data.color ?? '—'}
              </div>
              <div>
                <span className="text-muted-foreground">Branch:</span> {data.branch_name}
              </div>
            </div>

            {permissions.canUpdate && data.status !== 'DELIVERED' && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Edit permitted details</CardTitle>
                  <CardDescription>VIN and chassis remain immutable identifiers.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="grid gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      updateMutation.mutate({
                        stockUnitId: data.id,
                        expectedVersion: data.version,
                        engineNumber: String(form.get('engineNumber') ?? '').trim() || null,
                        color: String(form.get('color') ?? '').trim() || null,
                        receivedAt: toIsoOrNull(form.get('receivedAt')),
                        reason: String(form.get('reason') ?? ''),
                        requestId: requestId('update'),
                      });
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        name="engineNumber"
                        maxLength={32}
                        defaultValue={data.engine_number ?? ''}
                        placeholder="Engine number"
                      />
                      <Input
                        name="color"
                        maxLength={80}
                        defaultValue={data.color ?? ''}
                        placeholder="Colour"
                      />
                      <Input
                        name="receivedAt"
                        type="datetime-local"
                        defaultValue={data.received_at ? data.received_at.slice(0, 16) : ''}
                      />
                      <Input
                        name="reason"
                        required
                        minLength={5}
                        maxLength={1000}
                        placeholder="Reason for change"
                      />
                    </div>
                    {updateMutation.isError && <OperationError error={updateMutation.error} />}
                    <Button
                      type="submit"
                      size="sm"
                      className="justify-self-start"
                      disabled={updateMutation.isPending}
                    >
                      <Pencil className="size-3.5" />{' '}
                      {updateMutation.isPending ? 'Saving…' : 'Save details'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            )}

            {permissions.canUpdate && lifecycleOptions.length > 0 && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Change lifecycle status</CardTitle>
                </CardHeader>
                <CardContent>
                  <form
                    className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!status) return;
                      const form = new FormData(event.currentTarget);
                      statusMutation.mutate({
                        stockUnitId: data.id,
                        expectedVersion: data.version,
                        status,
                        reason: String(form.get('reason') ?? ''),
                        requestId: requestId('status'),
                      });
                    }}
                  >
                    <Select value={status} onValueChange={setStatus}>
                      <SelectTrigger>
                        <SelectValue placeholder="Next status" />
                      </SelectTrigger>
                      <SelectContent>
                        {lifecycleOptions.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item.replaceAll('_', ' ')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      name="reason"
                      required
                      minLength={5}
                      maxLength={1000}
                      placeholder="Reason"
                    />
                    <Button type="submit" size="sm" disabled={!status || statusMutation.isPending}>
                      Update
                    </Button>
                    {statusMutation.isError && (
                      <div className="sm:col-span-3">
                        <OperationError error={statusMutation.error} />
                      </div>
                    )}
                  </form>
                </CardContent>
              </Card>
            )}

            {permissions.canMove &&
              ['INCOMING', 'AVAILABLE', 'HOLD'].includes(data.status) &&
              !activeAllocation && (
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Transfer branch</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form
                      className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!toBranchId) return;
                        const form = new FormData(event.currentTarget);
                        moveMutation.mutate({
                          stockUnitId: data.id,
                          expectedVersion: data.version,
                          toBranchId,
                          reason: String(form.get('reason') ?? ''),
                          requestId: requestId('move'),
                        });
                      }}
                    >
                      <Select value={toBranchId} onValueChange={setToBranchId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {branches
                            .filter((branch) => branch.id !== data.branch_id)
                            .map((branch) => (
                              <SelectItem key={branch.id} value={branch.id}>
                                {branch.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Input
                        name="reason"
                        required
                        minLength={5}
                        maxLength={1000}
                        placeholder="Transfer reason"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!toBranchId || moveMutation.isPending}
                      >
                        <ArrowLeftRight className="size-3.5" /> Transfer
                      </Button>
                      {moveMutation.isError && (
                        <div className="sm:col-span-3">
                          <OperationError error={moveMutation.error} />
                        </div>
                      )}
                    </form>
                  </CardContent>
                </Card>
              )}

            {permissions.canAllocate && data.status === 'AVAILABLE' && !activeAllocation && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Reserve or allocate</CardTitle>
                  <CardDescription>
                    This links stock only; booking lifecycle remains booking-owned.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="grid gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!bookingId) return;
                      allocationMutation.mutate({
                        stockUnitId: data.id,
                        expectedStockVersion: data.version,
                        bookingId,
                        allocationStatus,
                        existingAllocationId: null,
                        expectedAllocationVersion: null,
                        requestId: requestId('allocation'),
                      });
                    }}
                  >
                    <Input
                      value={bookingSearch}
                      onChange={(event) => setBookingSearch(event.target.value)}
                      maxLength={100}
                      placeholder="Search booking or customer…"
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Select value={bookingId} onValueChange={setBookingId}>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              bookings.isPending ? 'Loading bookings…' : 'Select booking'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {bookings.data?.map((booking) => (
                            <SelectItem key={booking.id} value={booking.id}>
                              {booking.booking_number}
                              {booking.customer_name ? ` · ${booking.customer_name}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={allocationStatus}
                        onValueChange={(value) =>
                          setAllocationStatus(value as typeof allocationStatus)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="RESERVED">Reserve</SelectItem>
                          <SelectItem value="ALLOCATED">Allocate VIN</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {allocationMutation.isError && (
                      <OperationError error={allocationMutation.error} />
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      className="justify-self-start"
                      disabled={!bookingId || allocationMutation.isPending}
                    >
                      <PackageCheck className="size-3.5" />{' '}
                      {allocationStatus === 'RESERVED' ? 'Reserve stock' : 'Allocate stock'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            )}

            {permissions.canAllocate &&
              data.status === 'RESERVED' &&
              activeAllocation?.status === 'RESERVED' &&
              activeAllocation.booking_id && (
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Confirm VIN allocation</CardTitle>
                    <CardDescription>
                      {activeAllocation.booking_number ?? 'Linked booking'} is currently reserved.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {allocationMutation.isError && (
                      <OperationError error={allocationMutation.error} />
                    )}
                    <Button
                      size="sm"
                      disabled={allocationMutation.isPending}
                      onClick={() =>
                        allocationMutation.mutate({
                          stockUnitId: data.id,
                          expectedStockVersion: data.version,
                          bookingId: activeAllocation.booking_id as string,
                          allocationStatus: 'ALLOCATED',
                          existingAllocationId: activeAllocation.id,
                          expectedAllocationVersion: activeAllocation.version,
                          requestId: requestId('allocation-advance'),
                        })
                      }
                    >
                      <PackageCheck className="size-3.5" /> Allocate reserved VIN
                    </Button>
                  </CardContent>
                </Card>
              )}

            {permissions.canAllocate &&
              activeAllocation &&
              ((activeAllocation.status === 'RESERVED' && data.status === 'RESERVED') ||
                (activeAllocation.status === 'ALLOCATED' &&
                  ['ALLOCATED', 'READY_FOR_DELIVERY'].includes(data.status))) && (
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Release allocation</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form
                      className="grid gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        releaseMutation.mutate({
                          allocationId: activeAllocation.id,
                          expectedAllocationVersion: activeAllocation.version,
                          expectedStockVersion: data.version,
                          reason: String(form.get('reason') ?? ''),
                          requestId: requestId('release'),
                        });
                      }}
                    >
                      <Textarea
                        name="reason"
                        required
                        minLength={5}
                        maxLength={1000}
                        rows={2}
                        placeholder="Release reason"
                      />
                      {releaseMutation.isError && <OperationError error={releaseMutation.error} />}
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                        disabled={releaseMutation.isPending}
                      >
                        Release to available
                      </Button>
                    </form>
                  </CardContent>
                </Card>
              )}

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Movement history</CardTitle>
                <CardDescription>Latest 100 append-only events.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.movements.length ? (
                  data.movements.map((movement) => (
                    <div key={movement.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <StatusBadge value={movement.movement_type} />
                        <span className="text-xs text-muted-foreground">
                          {new Date(movement.moved_at).toLocaleString('en-IN')}
                        </span>
                      </div>
                      <p className="mt-2">
                        {movement.from_branch_name ?? 'External / intake'} →{' '}
                        {movement.to_branch_name ?? data.branch_name}
                      </p>
                      {movement.reason && (
                        <p className="mt-1 text-xs text-muted-foreground">{movement.reason}</p>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No movement history is available.</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
