'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  createBooking,
  decideQuotationApproval,
  fetchBookingQuotationOptions,
  fetchQuotationLeadOptions,
  saveQuotation,
  transitionBooking,
  transitionQuotation,
  type BookingRecord,
  type QuotationItem,
  type QuotationRecord,
} from './sales-document-api';
import { isSalesDocumentVersionConflict } from './sales-document-query';

const itemTypes = ['VEHICLE', 'ACCESSORY', 'INSURANCE', 'SERVICE', 'DISCOUNT', 'OTHER'] as const;

const emptyItem = (): QuotationItem => ({
  item_type: 'VEHICLE',
  description: '',
  quantity: 1,
  unit_price: 0,
  adjustment: 0,
});

function currency(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);
}

export function QuotationDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record?: QuotationRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [leadId, setLeadId] = useState(record?.lead_id ?? '');
  const [leadSearch, setLeadSearch] = useState('');
  const [items, setItems] = useState<QuotationItem[]>(
    record?.items.length ? record.items : [emptyItem()],
  );
  const requestId = useRef<string | null>(null);
  const debouncedLeadSearch = useDebouncedValue(leadSearch, 300);
  const options = useQuery({
    queryKey: ['quotation-lead-options', debouncedLeadSearch],
    queryFn: ({ signal }) => fetchQuotationLeadOptions(debouncedLeadSearch, signal),
    enabled: open && !record,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: saveQuotation,
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const total = items.reduce(
    (sum, item) => sum + Number(item.quantity) * Number(item.unit_price) + Number(item.adjustment),
    0,
  );
  const updateItem = (index: number, patch: Partial<QuotationItem>) => {
    requestId.current = null;
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? 'Edit quotation' : 'Create quotation'}</DialogTitle>
          <DialogDescription>
            Totals are recalculated on the server. Discounts above 10% require a distinct approver.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            requestId.current ??= globalThis.crypto.randomUUID();
            mutation.mutate({
              quotationId: record?.id ?? null,
              expectedVersion: record?.version ?? null,
              leadId,
              items,
              requestId: requestId.current,
            });
          }}
        >
          <div className="grid gap-2">
            <Label>Customer opportunity</Label>
            {record ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="font-medium">{record.customer_name}</p>
                <p className="text-xs text-muted-foreground">
                  {record.interested_model ?? 'Vehicle not specified'} · {record.branch_name}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  value={leadSearch}
                  maxLength={160}
                  placeholder="Search customer, phone, model or lead ID"
                  onChange={(event) => setLeadSearch(event.target.value)}
                />
                <Select
                  value={leadId}
                  onValueChange={(value) => {
                    requestId.current = null;
                    setLeadId(value);
                  }}
                  required
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        options.isPending ? 'Loading opportunities…' : 'Select opportunity'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(options.data ?? []).map((option) => (
                      <SelectItem key={option.lead_id} value={option.lead_id}>
                        {option.customer_name} · {option.interested_model ?? 'Vehicle TBD'} ·{' '}
                        {option.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Line items</Label>
                <p className="text-xs text-muted-foreground">
                  Negative adjustments represent discounts.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={items.length >= 50}
                onClick={() => {
                  requestId.current = null;
                  setItems((current) => [...current, emptyItem()]);
                }}
              >
                <Plus className="size-4" /> Add item
              </Button>
            </div>
            {items.map((item, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 md:grid-cols-12">
                <div className="md:col-span-3">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={item.item_type}
                    onValueChange={(value) =>
                      updateItem(index, {
                        item_type: value,
                        ...(value === 'DISCOUNT' ? { unit_price: 0, adjustment: -1 } : {}),
                      })
                    }
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {itemTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type.replaceAll('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-5">
                  <Label className="text-xs">Description</Label>
                  <Input
                    className="mt-1"
                    value={item.description}
                    maxLength={240}
                    required
                    onChange={(event) => updateItem(index, { description: event.target.value })}
                  />
                </div>
                <div className="md:col-span-2">
                  <Label className="text-xs">Quantity</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={item.quantity}
                    required
                    onChange={(event) =>
                      updateItem(index, { quantity: Number(event.target.value) })
                    }
                  />
                </div>
                <div className="md:col-span-2">
                  <Label className="text-xs">Unit price</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0"
                    max="1000000000"
                    step="0.01"
                    disabled={item.item_type === 'DISCOUNT'}
                    value={item.unit_price}
                    required
                    onChange={(event) =>
                      updateItem(index, { unit_price: Number(event.target.value) })
                    }
                  />
                </div>
                <div className="md:col-span-3 md:col-start-9">
                  <Label className="text-xs">Adjustment</Label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="-1000000000"
                    max="1000000000"
                    step="0.01"
                    value={item.adjustment}
                    required
                    onChange={(event) =>
                      updateItem(index, { adjustment: Number(event.target.value) })
                    }
                  />
                </div>
                <div className="flex items-end justify-end md:col-span-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={items.length === 1}
                    aria-label="Remove item"
                    onClick={() => {
                      requestId.current = null;
                      setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-lg bg-muted/40 px-4 py-3">
            <span className="text-sm text-muted-foreground">Calculated total</span>
            <span className="text-lg font-semibold">{currency(total)}</span>
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isSalesDocumentVersionConflict(mutation.error)
                  ? 'This quotation changed elsewhere. Close and reopen it before saving.'
                  : 'The quotation could not be saved. Check the line items, discount and opportunity.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !leadId || total < 0}>
              {mutation.isPending ? 'Saving…' : record ? 'Save new version' : 'Create quotation'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BookingCreateDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [quotationId, setQuotationId] = useState('');
  const [quotationSearch, setQuotationSearch] = useState('');
  const [amount, setAmount] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [financeRequired, setFinanceRequired] = useState(false);
  const [exchangeRequired, setExchangeRequired] = useState(false);
  const requestId = useRef<string | null>(null);
  const debouncedQuotationSearch = useDebouncedValue(quotationSearch, 300);
  const options = useQuery({
    queryKey: ['booking-quotation-options', debouncedQuotationSearch],
    queryFn: ({ signal }) => fetchBookingQuotationOptions(debouncedQuotationSearch, signal),
    enabled: open,
    staleTime: 60_000,
  });
  const selected = options.data?.find((option) => option.quotation_id === quotationId);
  const mutation = useMutation({
    mutationFn: createBooking,
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create booking</DialogTitle>
          <DialogDescription>
            A booking can only be created once from an accepted quotation.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected) return;
            requestId.current ??= globalThis.crypto.randomUUID();
            mutation.mutate({
              quotationId: selected.quotation_id,
              expectedQuotationVersion: selected.version,
              bookingAmount: Number(amount),
              financeRequired,
              exchangeRequired,
              expectedDeliveryDate: deliveryDate || null,
              requestId: requestId.current,
            });
          }}
        >
          <div className="grid gap-2">
            <Label>Accepted quotation</Label>
            <Input
              value={quotationSearch}
              maxLength={160}
              placeholder="Search quotation, customer or phone"
              onChange={(event) => setQuotationSearch(event.target.value)}
            />
            <Select
              value={quotationId}
              onValueChange={(value) => {
                requestId.current = null;
                setQuotationId(value);
                const option = options.data?.find((candidate) => candidate.quotation_id === value);
                setAmount(
                  option ? String(Math.min(option.total_amount, option.total_amount * 0.1)) : '',
                );
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={options.isPending ? 'Loading…' : 'Select quotation'} />
              </SelectTrigger>
              <SelectContent>
                {(options.data ?? []).map((option) => (
                  <SelectItem key={option.quotation_id} value={option.quotation_id}>
                    {option.quotation_number} · {option.customer_name} ·{' '}
                    {currency(option.total_amount)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{selected.customer_name}</p>
              <p className="text-xs text-muted-foreground">
                {selected.interested_model ?? 'Vehicle TBD'} · {selected.branch_name} · Total{' '}
                {currency(selected.total_amount)}
              </p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="booking-amount">Booking amount</Label>
              <Input
                id="booking-amount"
                type="number"
                min="0.01"
                max={selected?.total_amount}
                step="0.01"
                required
                value={amount}
                onChange={(event) => {
                  requestId.current = null;
                  setAmount(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="delivery-date">Expected delivery</Label>
              <Input
                id="delivery-date"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={deliveryDate}
                onChange={(event) => {
                  requestId.current = null;
                  setDeliveryDate(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={financeRequired ? 'default' : 'outline'}
              onClick={() => {
                requestId.current = null;
                setFinanceRequired((value) => !value);
              }}
            >
              Finance {financeRequired ? 'required' : 'not required'}
            </Button>
            <Button
              type="button"
              variant={exchangeRequired ? 'default' : 'outline'}
              onClick={() => {
                requestId.current = null;
                setExchangeRequired((value) => !value);
              }}
            >
              Exchange {exchangeRequired ? 'required' : 'not required'}
            </Button>
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isSalesDocumentVersionConflict(mutation.error)
                  ? 'The quotation changed. Close and reopen this dialog.'
                  : 'The booking could not be created. Confirm the quotation is still accepted and unbooked.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !selected || Number(amount) <= 0}>
              {mutation.isPending ? 'Creating…' : 'Create booking'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type QuotationAction =
  'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'APPROVED' | 'APPROVAL_REJECTED';
type BookingAction =
  'AWAITING_ALLOCATION' | 'ALLOCATED' | 'READY_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';

export function SalesDocumentActionDialog({
  record,
  action,
  open,
  onOpenChange,
  onSaved,
}: {
  record: QuotationRecord | BookingRecord;
  action: QuotationAction | BookingAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(
    'booking_number' in record ? (record.expected_delivery_date ?? '') : '',
  );
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      if ('quotation_number' in record && !('booking_number' in record)) {
        if (action === 'APPROVED' || action === 'APPROVAL_REJECTED')
          return decideQuotationApproval({
            quotationId: record.id,
            expectedVersion: record.version,
            decision: action === 'APPROVED' ? 'APPROVED' : 'REJECTED',
            comment: reason,
            requestId: requestId.current,
          });
        return transitionQuotation({
          quotationId: record.id,
          expectedVersion: record.version,
          status: action,
          reason,
          requestId: requestId.current,
        });
      }
      return transitionBooking({
        bookingId: record.id,
        expectedVersion: record.version,
        status: action,
        reason,
        expectedDeliveryDate: deliveryDate || null,
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const needsReason =
    action === 'REJECTED' ||
    action === 'EXPIRED' ||
    action === 'APPROVAL_REJECTED' ||
    action === 'CANCELLED';
  const label = action
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            This transition is validated, version-checked and written to the audit timeline.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {'booking_number' in record && (
            <div className="grid gap-2">
              <Label htmlFor="transition-delivery-date">Expected delivery</Label>
              <Input
                id="transition-delivery-date"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={deliveryDate}
                onChange={(event) => {
                  requestId.current = null;
                  setDeliveryDate(event.target.value);
                }}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="transition-reason">Reason {needsReason ? '' : '(optional)'}</Label>
            <Textarea
              id="transition-reason"
              required={needsReason}
              maxLength={500}
              rows={3}
              value={reason}
              onChange={(event) => {
                requestId.current = null;
                setReason(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {isSalesDocumentVersionConflict(mutation.error)
                  ? 'This record changed elsewhere. Close and reopen the action.'
                  : 'The transition was rejected. Check the current state, approval or stock allocation.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || (needsReason && !reason.trim())}>
              {mutation.isPending ? 'Saving…' : `Confirm ${label}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type { BookingAction, QuotationAction };
