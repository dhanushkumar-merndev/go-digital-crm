'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Box,
  CarFront,
  CheckCircle2,
  IndianRupee,
  Save,
  ShieldCheck,
  Tags,
  Wrench,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  fetchQuotationLeadOptions,
  fetchQuotationVehicleOptions,
  saveQuotation,
  type QuotationItem,
  type QuotationRecord,
} from './sales-document-api';
import { isSalesDocumentVersionConflict } from './sales-document-query';

type PriceKey =
  | 'vehicle'
  | 'insurance'
  | 'registration'
  | 'accessories'
  | 'warranty'
  | 'service'
  | 'exchange'
  | 'corporate'
  | 'dealer'
  | 'additional';
type PriceState = Record<PriceKey, string>;

const priceRows: Array<{
  key: PriceKey;
  label: string;
  icon: typeof CarFront;
  adjustment?: boolean;
}> = [
  { key: 'vehicle', label: 'Ex-showroom Price', icon: CarFront },
  { key: 'insurance', label: 'Insurance', icon: ShieldCheck },
  { key: 'registration', label: 'Registration Charges', icon: IndianRupee },
  { key: 'accessories', label: 'Accessories', icon: Box },
  { key: 'warranty', label: 'Extended Warranty', icon: ShieldCheck },
  { key: 'service', label: 'Service Package', icon: Wrench },
  { key: 'exchange', label: 'Exchange Value', icon: Tags, adjustment: true },
  { key: 'corporate', label: 'Corporate Offer', icon: Tags, adjustment: true },
  { key: 'dealer', label: 'Dealer Discount', icon: Tags, adjustment: true },
  { key: 'additional', label: 'Additional Discount', icon: Tags, adjustment: true },
];

const emptyPrices = (): PriceState => ({
  vehicle: '',
  insurance: '',
  registration: '',
  accessories: '',
  warranty: '',
  service: '',
  exchange: '',
  corporate: '',
  dealer: '',
  additional: '',
});
const asAmount = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const money = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);

function initialPricing(record?: QuotationRecord | null): PriceState {
  const values = emptyPrices();
  if (!record) return values;
  for (const item of record.items) {
    const description = item.description.toLowerCase();
    const amount = String(Math.abs(item.adjustment || item.quantity * item.unit_price));
    if (item.item_type === 'VEHICLE') values.vehicle = String(item.unit_price);
    else if (item.item_type === 'INSURANCE') values.insurance = String(item.unit_price);
    else if (item.item_type === 'ACCESSORY') values.accessories = String(item.unit_price);
    else if (item.item_type === 'SERVICE' && description.includes('warranty'))
      values.warranty = String(item.unit_price);
    else if (item.item_type === 'SERVICE') values.service = String(item.unit_price);
    else if (item.item_type === 'OTHER' && description.includes('registration'))
      values.registration = String(item.unit_price);
    else if (item.item_type === 'DISCOUNT' && description.includes('exchange'))
      values.exchange = amount;
    else if (item.item_type === 'DISCOUNT' && description.includes('corporate'))
      values.corporate = amount;
    else if (item.item_type === 'DISCOUNT' && description.includes('dealer'))
      values.dealer = amount;
    else if (item.item_type === 'DISCOUNT') values.additional = amount;
  }
  return values;
}

function initialVehicle(record?: QuotationRecord | null) {
  const description = record?.items.find((item) => item.item_type === 'VEHICLE')?.description ?? '';
  const parts = description.split(' · ').map((part) => part.trim());
  return { model: parts[0] ?? '', variant: parts[1] ?? '', colour: parts[2] ?? '' };
}

function initialValidity(record?: QuotationRecord | null) {
  const saved = record?.items
    .find((item) => item.item_type === 'OTHER' && item.description.startsWith('Validity: '))
    ?.description.slice(10);
  if (saved) return saved;
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

export function QuotationCreateView({
  record,
  onBack,
  onSaved,
}: {
  record?: QuotationRecord | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const vehicle = initialVehicle(record);
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState(record?.lead_id ?? '');
  const [model, setModel] = useState(vehicle.model || record?.interested_model || '');
  const [variant, setVariant] = useState(vehicle.variant);
  const [colour, setColour] = useState(vehicle.colour);
  const [validUntil, setValidUntil] = useState(() => initialValidity(record));
  const [prices, setPrices] = useState<PriceState>(() => initialPricing(record));
  const requestId = useRef<string | null>(null);
  const debounced = useDebouncedValue(search, 300);
  const leads = useQuery({
    queryKey: ['quotation-lead-options', debounced],
    queryFn: ({ signal }) => fetchQuotationLeadOptions(debounced, signal),
    enabled: !record,
    staleTime: 60_000,
  });
  const selected = leads.data?.find((item) => item.lead_id === leadId);
  const branchId = selected?.branch_id ?? record?.branch_id ?? '';
  const vehicleOptions = useQuery({
    queryKey: ['quotation-vehicle-options', branchId],
    queryFn: ({ signal }) => fetchQuotationVehicleOptions(branchId, signal),
    enabled: Boolean(branchId),
    staleTime: 60_000,
  });
  const mutation = useMutation({ mutationFn: saveQuotation, onSuccess: onSaved });

  const additions =
    asAmount(prices.insurance) +
    asAmount(prices.registration) +
    asAmount(prices.accessories) +
    asAmount(prices.warranty) +
    asAmount(prices.service);
  const adjustments =
    asAmount(prices.exchange) +
    asAmount(prices.corporate) +
    asAmount(prices.dealer) +
    asAmount(prices.additional);
  const gross = asAmount(prices.vehicle) + additions;
  const total = Math.max(0, gross - adjustments);
  const requiresApproval = gross > 0 && adjustments > gross * 0.1;
  const valid = Boolean(
    leadId && model.trim() && validUntil && asAmount(prices.vehicle) > 0 && adjustments <= gross,
  );

  const items = useMemo<QuotationItem[]>(() => {
    const result: QuotationItem[] = [
      {
        item_type: 'VEHICLE',
        description: [model, variant, colour]
          .map((value) => value.trim())
          .filter(Boolean)
          .join(' · '),
        quantity: 1,
        unit_price: asAmount(prices.vehicle),
        adjustment: 0,
      },
    ];
    const additionsToSave: Array<[PriceKey, string, QuotationItem['item_type']]> = [
      ['insurance', 'Insurance', 'INSURANCE'],
      ['registration', 'Registration Charges', 'OTHER'],
      ['accessories', 'Accessories', 'ACCESSORY'],
      ['warranty', 'Extended Warranty', 'SERVICE'],
      ['service', 'Service Package', 'SERVICE'],
    ];
    for (const [key, description, itemType] of additionsToSave) {
      const amount = asAmount(prices[key]);
      if (amount > 0)
        result.push({
          item_type: itemType,
          description,
          quantity: 1,
          unit_price: amount,
          adjustment: 0,
        });
    }
    const adjustmentsToSave: Array<[PriceKey, string]> = [
      ['exchange', 'Exchange Value'],
      ['corporate', 'Corporate Offer'],
      ['dealer', 'Dealer Discount'],
      ['additional', 'Additional Discount'],
    ];
    for (const [key, description] of adjustmentsToSave) {
      const amount = asAmount(prices[key]);
      if (amount > 0)
        result.push({
          item_type: 'DISCOUNT',
          description,
          quantity: 1,
          unit_price: 0,
          adjustment: -amount,
        });
    }
    result.push({
      item_type: 'OTHER',
      description: `Validity: ${validUntil}`,
      quantity: 1,
      unit_price: 0,
      adjustment: 0,
    });
    return result;
  }, [colour, model, prices, validUntil, variant]);

  const submit = () => {
    if (!valid) return;
    requestId.current ??= crypto.randomUUID();
    mutation.mutate({
      quotationId: record?.id ?? null,
      expectedVersion: record?.version ?? null,
      leadId,
      items,
      requestId: requestId.current,
    });
  };
  const chooseLead = (value: string) => {
    setLeadId(value);
    const lead = leads.data?.find((item) => item.lead_id === value);
    if (lead?.interested_model) setModel(lead.interested_model);
    setVariant('');
    setColour('');
    requestId.current = null;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button className="mb-2 flex items-center gap-1 text-sm text-primary" onClick={onBack}>
            <ArrowLeft className="size-4" /> Quotations
          </button>
          <h1 className="text-2xl font-bold">{record ? 'Revise Quotation' : 'Create Quotation'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a professional quotation for your customer.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={submit}>
            <Save className="size-4" />
            {mutation.isPending ? 'Saving…' : requiresApproval ? 'Request Approval' : 'Save Draft'}
          </Button>
        </div>
      </div>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {isSalesDocumentVersionConflict(mutation.error)
              ? 'This quotation changed elsewhere. Return to the list and reopen it.'
              : 'The quotation could not be saved. Check the customer and pricing values.'}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_380px]">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Vehicle & Pricing Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  Customer <span className="text-destructive">*</span>
                </Label>
                {record ? (
                  <div className="flex h-10 items-center rounded-md border px-3 text-sm">
                    {record.customer_name} · {record.phone ?? 'No phone'}
                  </div>
                ) : (
                  <>
                    <Input
                      value={search}
                      placeholder="Search customer name, phone or lead ID"
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <Select value={leadId} onValueChange={chooseLead}>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={leads.isPending ? 'Loading…' : 'Select customer opportunity'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {leads.data?.map((item) => (
                          <SelectItem key={item.lead_id} value={item.lead_id}>
                            {item.customer_name} · {item.phone ?? 'No phone'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <VehicleSelect
                  label="Model"
                  value={model}
                  options={vehicleOptions.data?.models ?? []}
                  onChange={setModel}
                  required
                />
                <VehicleSelect
                  label="Variant"
                  value={variant}
                  options={vehicleOptions.data?.variants ?? []}
                  onChange={setVariant}
                />
                <VehicleSelect
                  label="Colour"
                  value={colour}
                  options={vehicleOptions.data?.colors ?? []}
                  onChange={setColour}
                />
                <div className="space-y-2">
                  <Label>Branch</Label>
                  <div className="flex h-10 items-center truncate rounded-md border bg-muted/30 px-3 text-sm">
                    {selected?.branch_name ?? record?.branch_name ?? 'Select customer first'}
                  </div>
                </div>
              </div>
            </div>

            <div className="divide-y rounded-lg border">
              {priceRows.map((row) => {
                const Icon = row.icon;
                return (
                  <div
                    key={row.key}
                    className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_260px]"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`grid size-8 place-items-center rounded-full ${row.adjustment ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600'}`}
                      >
                        <Icon className="size-4" />
                      </span>
                      <Label htmlFor={`quotation-${row.key}`}>
                        {row.label}
                        {row.key === 'vehicle' && <span className="text-destructive"> *</span>}
                      </Label>
                    </div>
                    <div className="relative">
                      <span
                        className={`absolute left-3 top-1/2 -translate-y-1/2 text-sm ${row.adjustment ? 'text-rose-600' : 'text-muted-foreground'}`}
                      >
                        {row.adjustment ? '- ₹' : '₹'}
                      </span>
                      <Input
                        id={`quotation-${row.key}`}
                        className={`pl-10 text-right font-medium ${row.adjustment ? 'text-rose-600' : ''}`}
                        type="number"
                        min="0"
                        max="1000000000"
                        step="1"
                        value={prices[row.key]}
                        placeholder="0"
                        onChange={(event) => {
                          requestId.current = null;
                          setPrices((current) => ({ ...current, [row.key]: event.target.value }));
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="max-w-sm space-y-2">
              <Label htmlFor="quotation-validity">
                Quotation Validity <span className="text-destructive">*</span>
              </Label>
              <Input
                id="quotation-validity"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
                required
              />
            </div>
          </CardContent>
        </Card>

        <div className="sticky top-20">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Price Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <SummaryRow label="Vehicle Price" value={asAmount(prices.vehicle)} />
              <SummaryRow label="Add-ons" value={additions} />
              <SummaryRow label="Adjustments" value={-adjustments} negative />
              <div className="border-t pt-4">
                <div className="flex justify-between text-base text-blue-700">
                  <strong>Final On-Road Price</strong>
                  <strong>{money(total)}</strong>
                </div>
              </div>
              {requiresApproval && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  Discounts exceed 10%. Saving sends this quotation for manager approval.
                </div>
              )}
              {adjustments > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
                  <CheckCircle2 className="size-4" /> Customer saves {money(adjustments)}
                </div>
              )}
              <Button className="w-full" disabled={!valid || mutation.isPending} onClick={submit}>
                <Save className="size-4" />
                {mutation.isPending
                  ? 'Saving…'
                  : requiresApproval
                    ? 'Request Approval'
                    : 'Save Draft'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function VehicleSelect({
  label,
  value,
  options,
  onChange,
  required,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const values = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="space-y-2">
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {values.length ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {values.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          maxLength={120}
          placeholder={`Enter ${label.toLowerCase()}`}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  negative,
}: {
  label: string;
  value: number;
  negative?: boolean;
}) {
  return (
    <div className={`flex justify-between ${negative && value ? 'text-rose-600' : ''}`}>
      <span>{label}</span>
      <strong>{negative && value ? `- ${money(Math.abs(value))}` : money(value)}</strong>
    </div>
  );
}
