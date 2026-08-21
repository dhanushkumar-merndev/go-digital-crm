'use client';

import { useMemo, useRef, useState, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CarFront,
  Check,
  CircleUserRound,
  Download,
  FileText,
  IndianRupee,
  Loader2,
  Mail,
  Phone,
  RotateCcw,
  Save,
  Send,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
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
import { Textarea } from '@/components/ui/textarea';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { fetchOperationalCasePermissions } from './operational-case-api';
import {
  downloadSalesExchangeDocument,
  fetchSalesExchangeOptions,
  saveSalesExchangeRequest,
  uploadSalesExchangeDocument,
  type SalesExchangeOption,
  type SaveSalesExchangeInput,
} from './sales-exchange-api';

type ExchangeForm = {
  vehicleId: string;
  registration: string;
  brand: string;
  model: string;
  variant: string;
  modelYear: string;
  fuelType: string;
  ownership: string;
  odometerKm: string;
  customerExpectedValue: string;
  notes: string;
};

const emptyForm: ExchangeForm = {
  vehicleId: '',
  registration: '',
  brand: '',
  model: '',
  variant: '',
  modelYear: '',
  fuelType: '',
  ownership: '',
  odometerKm: '',
  customerExpectedValue: '',
  notes: '',
};

const workflow = [
  { key: 'REQUESTED', label: 'Requested' },
  { key: 'EVALUATED', label: 'Evaluated' },
  { key: 'OFFERED', label: 'Customer approval' },
  { key: 'ACCEPTED', label: 'Exchange confirmed' },
] as const;

const statusRank: Record<string, number> = {
  DRAFT: -1,
  REQUESTED: 0,
  INSPECTION_SCHEDULED: 0,
  EVALUATED: 1,
  OFFERED: 2,
  ACCEPTED: 3,
};

function numberOrUndefined(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function money(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function shortDate(value: string | null | undefined) {
  if (!value) return 'Pending';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Pending'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date);
}

function customerAddress(option: SalesExchangeOption) {
  if (!option.address) return 'Address not recorded';
  const parts = Object.values(option.address).filter(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  );
  return parts.length ? parts.join(', ') : 'Address not recorded';
}

function formForOption(option: SalesExchangeOption): ExchangeForm {
  const linked =
    option.vehicles.find((vehicle) => vehicle.id === option.vehicle_id) ?? option.vehicles[0];
  return {
    vehicleId: linked?.id ?? '',
    registration: linked?.registration ?? '',
    brand: linked?.brand ?? '',
    model: linked?.model ?? '',
    variant: linked?.variant ?? '',
    modelYear: linked?.model_year ? String(linked.model_year) : '',
    fuelType: option.fuel_type ?? '',
    ownership: option.ownership ?? '',
    odometerKm: option.odometer_km == null ? '' : String(option.odometer_km),
    customerExpectedValue:
      option.customer_expected_value == null ? '' : String(option.customer_expected_value),
    notes: option.notes ?? '',
  };
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: typeof CarFront;
  children: React.ReactNode;
}) {
  return (
    <CardTitle className="flex items-center gap-2 text-base">
      <span className="grid size-8 place-items-center rounded-md bg-blue-50 text-blue-600">
        <Icon className="size-4" />
      </span>
      {children}
    </CardTitle>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label} {required ? <span className="text-red-500">*</span> : null}
      </Label>
      {children}
    </div>
  );
}

export function SalesExchangeWorkspace() {
  const queryClient = useQueryClient();
  const [selectedBookingId, setSelectedBookingId] = useState('');
  const [formState, setFormState] = useState<{
    bookingId: string;
    value: ExchangeForm;
  }>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const uploadInput = useRef<HTMLInputElement>(null);
  const rcInput = useRef<HTMLInputElement>(null);

  const permissions = useQuery({
    queryKey: ['operational-case-permissions', 'EXCHANGE'],
    queryFn: () => fetchOperationalCasePermissions('EXCHANGE'),
    staleTime: 60_000,
  });
  const options = useQuery({
    queryKey: ['sales-exchange-options', permissions.data?.organizationId],
    queryFn: ({ signal }) => fetchSalesExchangeOptions('', signal),
    enabled: Boolean(permissions.data?.canRequest),
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    {
      resource: 'operations',
      queryKeys: [['sales-exchange-options'], ['operational-cases'], ['customer-360']],
    },
  ]);
  const effectiveBookingId = selectedBookingId || options.data?.[0]?.booking_id || '';
  const selected = useMemo(
    () => options.data?.find((option) => option.booking_id === effectiveBookingId),
    [effectiveBookingId, options.data],
  );
  const form =
    formState?.bookingId === effectiveBookingId
      ? formState.value
      : selected
        ? formForOption(selected)
        : emptyForm;
  const setForm = (action: SetStateAction<ExchangeForm>) => {
    const value = typeof action === 'function' ? action(form) : action;
    setFormState({ bookingId: effectiveBookingId, value });
  };

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sales-exchange-options'] }),
      queryClient.invalidateQueries({ queryKey: ['operational-cases'] }),
      queryClient.invalidateQueries({ queryKey: ['customer-360'] }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: saveSalesExchangeRequest,
    onSuccess: async (result, input) => {
      setError(undefined);
      setMessage(
        input.action === 'SAVE_DRAFT'
          ? 'Exchange draft saved.'
          : input.action === 'REQUEST_EVALUATION'
            ? 'Evaluation request submitted.'
            : 'Exchange offer accepted and submitted.',
      );
      await invalidate();
    },
    onError: (cause: { message?: string }) => {
      if (cause.message === 'OPERATIONAL_CASE_VERSION_CONFLICT')
        setError('This exchange changed in another session. Refresh and try again.');
      else if (cause.message === 'EXCHANGE_REQUIRED_FIELDS_MISSING')
        setError(
          'Complete every required vehicle and valuation field before requesting evaluation.',
        );
      else setError('The exchange action could not be completed. Check the fields and try again.');
    },
  });
  const uploadMutation = useMutation({
    mutationFn: uploadSalesExchangeDocument,
    onSuccess: invalidate,
    onError: () => setError('The private Tigris upload failed. Check the file and retry.'),
  });

  const update = (key: keyof ExchangeForm, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = (action: SaveSalesExchangeInput['action']) => {
    if (!selected) return;
    setError(undefined);
    setMessage(undefined);
    saveMutation.mutate({
      bookingId: selected.booking_id,
      caseId: selected.case_id ?? undefined,
      expectedVersion: selected.case_version ?? undefined,
      vehicleId: form.vehicleId || undefined,
      registration: form.registration.trim(),
      brand: form.brand.trim(),
      model: form.model.trim(),
      variant: form.variant.trim(),
      modelYear: numberOrUndefined(form.modelYear),
      fuelType: form.fuelType,
      ownership: form.ownership,
      odometerKm: numberOrUndefined(form.odometerKm),
      customerExpectedValue: numberOrUndefined(form.customerExpectedValue),
      notes: form.notes.trim(),
      action,
      requestId: crypto.randomUUID(),
    });
  };

  const uploadFile = (file: File | undefined, kind: 'photo' | 'rc') => {
    if (!file || !selected?.case_id || !permissions.data) return;
    const allowed =
      kind === 'photo'
        ? ['image/jpeg', 'image/png', 'image/webp']
        : ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type) || file.size < 1 || file.size > 25 * 1024 * 1024) {
      setError('Use PDF/JPEG/PNG/WebP files up to 25 MB. Vehicle photos must be images.');
      return;
    }
    if (
      kind === 'photo' &&
      selected.documents.filter((doc) => doc.mime_type.startsWith('image/')).length >= 8
    ) {
      setError('A maximum of 8 vehicle photos is allowed.');
      return;
    }
    uploadMutation.mutate({
      organizationId: permissions.data.organizationId,
      branchId: selected.branch_id,
      caseId: selected.case_id,
      file,
    });
  };

  if (permissions.isPending || options.isPending) return <PageSkeleton />;
  if (permissions.isError || options.isError || !permissions.data?.canRequest)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="p-10 text-center">
          <h2 className="font-semibold">Exchange workspace is unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your exchange request permission, assigned scope or workspace migration needs attention.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void options.refetch()}>
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  const editable = !selected?.case_status || ['DRAFT', 'REQUESTED'].includes(selected.case_status);
  const evaluationValue = selected?.evaluation?.quoted_value ?? selected?.estimated_value;
  const rank = statusRank[selected?.case_status ?? 'DRAFT'] ?? -1;
  const busy = saveMutation.isPending || uploadMutation.isPending;
  const photos =
    selected?.documents.filter((document) => document.mime_type.startsWith('image/')) ?? [];
  const rcDocuments =
    selected?.documents.filter((document) => !document.mime_type.startsWith('image/')) ?? [];

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Link href="/sales-consultant/dashboard" className="text-blue-600 hover:underline">
              Dashboard
            </Link>
            <span>›</span>
            <span>Exchange</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Exchange Vehicle</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Capture existing vehicle details and manage the exchange evaluation process.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setForm(selected ? formForOption(selected) : emptyForm)}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={
              busy ||
              !selected ||
              (selected.case_status != null && selected.case_status !== 'DRAFT')
            }
            onClick={() => submit('SAVE_DRAFT')}
          >
            <Save className="size-4" /> Save draft
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selected || !editable}
            onClick={() => submit('REQUEST_EVALUATION')}
          >
            <Send className="size-4" /> Request evaluation
          </Button>
          <Button
            disabled={busy || selected?.case_status !== 'OFFERED'}
            onClick={() => submit('ACCEPT_OFFER')}
          >
            <Check className="size-4" /> Submit exchange
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {!options.data?.length ? (
        <Card>
          <CardContent className="p-10 text-center">
            <CarFront className="mx-auto size-8 text-muted-foreground" />
            <h2 className="mt-3 font-semibold">No eligible exchange bookings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A confirmed booking assigned to you must have Exchange Required enabled.
            </p>
          </CardContent>
        </Card>
      ) : selected ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2.45fr)_minmax(300px,0.95fr)]">
          <div className="space-y-4">
            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <SectionTitle icon={CircleUserRound}>Customer</SectionTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <Field label="Customer" required>
                  <Select value={selected.booking_id} onValueChange={setSelectedBookingId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.data.map((option) => (
                        <SelectItem key={option.booking_id} value={option.booking_id}>
                          {option.customer_name} · {option.booking_number}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Mobile" required>
                  <div className="relative">
                    <Input value={selected.phone ?? ''} readOnly className="pr-10" />
                    {selected.phone ? (
                      <a
                        href={`tel:${selected.phone}`}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600"
                      >
                        <Phone className="size-4" />
                      </a>
                    ) : null}
                  </div>
                </Field>
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <SectionTitle icon={CarFront}>Existing Vehicle</SectionTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                {selected.vehicles.length ? (
                  <div className="md:col-span-3">
                    <Field label="Saved customer vehicle">
                      <Select
                        value={form.vehicleId || 'new'}
                        onValueChange={(value) => {
                          if (value === 'new')
                            return setForm((current) => ({
                              ...emptyForm,
                              fuelType: current.fuelType,
                              ownership: current.ownership,
                            }));
                          const vehicle = selected.vehicles.find((item) => item.id === value);
                          if (vehicle)
                            setForm((current) => ({
                              ...current,
                              vehicleId: vehicle.id,
                              registration: vehicle.registration ?? '',
                              brand: vehicle.brand ?? '',
                              model: vehicle.model ?? '',
                              variant: vehicle.variant ?? '',
                              modelYear: vehicle.model_year ? String(vehicle.model_year) : '',
                            }));
                        }}
                      >
                        <SelectTrigger disabled={!editable}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">Add another vehicle</SelectItem>
                          {selected.vehicles.map((vehicle) => (
                            <SelectItem key={vehicle.id} value={vehicle.id}>
                              {[vehicle.brand, vehicle.model, vehicle.registration]
                                .filter(Boolean)
                                .join(' · ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                ) : null}
                <Field label="Brand" required>
                  <Input
                    value={form.brand}
                    disabled={!editable}
                    onChange={(event) => update('brand', event.target.value)}
                  />
                </Field>
                <Field label="Model" required>
                  <Input
                    value={form.model}
                    disabled={!editable}
                    onChange={(event) => update('model', event.target.value)}
                  />
                </Field>
                <Field label="Variant">
                  <Input
                    value={form.variant}
                    disabled={!editable}
                    onChange={(event) => update('variant', event.target.value)}
                  />
                </Field>
                <Field label="Registration No." required>
                  <Input
                    value={form.registration}
                    disabled={!editable}
                    maxLength={24}
                    onChange={(event) => update('registration', event.target.value.toUpperCase())}
                  />
                </Field>
                <Field label="Year">
                  <Input
                    type="number"
                    min={1950}
                    max={2100}
                    value={form.modelYear}
                    disabled={!editable}
                    onChange={(event) => update('modelYear', event.target.value)}
                  />
                </Field>
                <Field label="KM Driven" required>
                  <Input
                    type="number"
                    min={0}
                    max={5000000}
                    value={form.odometerKm}
                    disabled={!editable}
                    onChange={(event) => update('odometerKm', event.target.value)}
                  />
                </Field>
                <Field label="Fuel Type" required>
                  <Select
                    value={form.fuelType}
                    disabled={!editable}
                    onValueChange={(value) => update('fuelType', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select fuel" />
                    </SelectTrigger>
                    <SelectContent>
                      {['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid', 'LPG'].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="md:col-span-2">
                  <Field label="Ownership" required>
                    <Select
                      value={form.ownership}
                      disabled={!editable}
                      onValueChange={(value) => update('ownership', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select ownership" />
                      </SelectTrigger>
                      <SelectContent>
                        {['First Owner', 'Second Owner', 'Third Owner', 'Fourth Owner or more'].map(
                          (value) => (
                            <SelectItem key={value} value={value}>
                              {value}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <SectionTitle icon={FileText}>Evaluation</SectionTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                <Field label="Customer Expected Price (₹)" required>
                  <Input
                    type="number"
                    min={0}
                    value={form.customerExpectedValue}
                    disabled={!editable}
                    onChange={(event) => update('customerExpectedValue', event.target.value)}
                  />
                </Field>
                <Field label="Evaluation status">
                  <Input
                    value={
                      selected.case_status
                        ? selected.case_status.replaceAll('_', ' ')
                        : 'Not requested'
                    }
                    readOnly
                  />
                </Field>
                <Field label="Evaluated Price (₹)">
                  <Input value={evaluationValue ?? ''} readOnly placeholder="Pending evaluation" />
                </Field>
                <div className="md:col-span-3">
                  <Field label="Notes">
                    <Textarea
                      value={form.notes}
                      disabled={!editable}
                      maxLength={4000}
                      onChange={(event) => update('notes', event.target.value)}
                      placeholder="Vehicle condition, finance closure, accessories or inspection notes"
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <SectionTitle icon={Upload}>Upload</SectionTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Vehicle Photos (Max 8)</Label>
                  <div className="flex flex-wrap gap-2">
                    {photos.map((document) => (
                      <button
                        key={document.id}
                        type="button"
                        className="flex h-20 w-28 flex-col items-center justify-center rounded-md border bg-muted/20 p-2 text-center text-xs"
                        onClick={async () =>
                          window.location.assign(
                            (await downloadSalesExchangeDocument(document.id)).download_url,
                          )
                        }
                      >
                        <CarFront className="mb-1 size-5 text-blue-600" />
                        <span className="line-clamp-2">{document.file_name}</span>
                      </button>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-20 border-dashed"
                      disabled={!selected.case_id || uploadMutation.isPending || photos.length >= 8}
                      onClick={() => uploadInput.current?.click()}
                    >
                      <Upload className="size-4" /> Add photo
                    </Button>
                    <input
                      ref={uploadInput}
                      hidden
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => {
                        uploadFile(event.target.files?.[0], 'photo');
                        event.target.value = '';
                      }}
                    />
                  </div>
                  {!selected.case_id ? (
                    <p className="text-xs text-muted-foreground">
                      Save the draft before uploading private files.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label>RC Copy</Label>
                  {rcDocuments.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      className="mb-2 flex w-full items-center gap-3 rounded-md border p-3 text-left text-sm"
                      onClick={async () =>
                        window.location.assign(
                          (await downloadSalesExchangeDocument(document.id)).download_url,
                        )
                      }
                    >
                      <FileText className="size-5 text-violet-600" />
                      <span className="min-w-0 flex-1 truncate">{document.file_name}</span>
                      <Download className="size-4" />
                    </button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!selected.case_id || uploadMutation.isPending}
                    onClick={() => rcInput.current?.click()}
                  >
                    <Upload className="size-4" /> Upload RC copy
                  </Button>
                  <input
                    ref={rcInput}
                    hidden
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/webp"
                    onChange={(event) => {
                      uploadFile(event.target.files?.[0], 'rc');
                      event.target.value = '';
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Exchange Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-2">
                  {workflow.map((step, index) => {
                    const completed = rank >= index;
                    return (
                      <div key={step.key} className="relative text-center">
                        <div
                          className={`relative z-10 mx-auto grid size-9 place-items-center rounded-full border-2 ${completed ? 'border-blue-600 bg-blue-600 text-white' : 'border-muted-foreground/30 bg-background text-muted-foreground'}`}
                        >
                          {completed ? <Check className="size-4" /> : index + 1}
                        </div>
                        {index < workflow.length - 1 ? (
                          <div
                            className={`absolute left-1/2 top-[17px] h-0.5 w-full ${rank > index ? 'bg-blue-600' : 'bg-border'}`}
                          />
                        ) : null}
                        <p className="relative z-10 mt-2 text-xs font-medium">{step.label}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {completed ? shortDate(selected.updated_at) : 'Pending'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Customer Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-full bg-blue-50 font-semibold text-blue-600">
                    {selected.customer_name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join('')
                      .toUpperCase()}
                  </span>
                  <div>
                    <Link
                      href={`/sales-consultant/customers/${selected.customer_id}`}
                      className="font-semibold text-blue-700 hover:underline"
                    >
                      {selected.customer_name}
                    </Link>
                    <p className="text-sm text-muted-foreground">{selected.booking_number}</p>
                  </div>
                </div>
                {selected.phone ? (
                  <a href={`tel:${selected.phone}`} className="flex items-center gap-2 text-sm">
                    <Phone className="size-4" /> {selected.phone}
                  </a>
                ) : null}
                {selected.email ? (
                  <a href={`mailto:${selected.email}`} className="flex items-center gap-2 text-sm">
                    <Mail className="size-4" /> {selected.email}
                  </a>
                ) : null}
                <p className="text-sm text-muted-foreground">{customerAddress(selected)}</p>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Vehicle Snapshot</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <span className="grid size-14 place-items-center rounded-lg bg-slate-50 text-slate-600">
                    <CarFront className="size-8" />
                  </span>
                  <div>
                    <p className="font-semibold">
                      {[form.brand, form.model, form.variant].filter(Boolean).join(' ') ||
                        'Vehicle not entered'}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {[
                        form.registration,
                        form.odometerKm
                          ? `${Number(form.odometerKm).toLocaleString('en-IN')} km`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {form.ownership || 'Ownership pending'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Evaluation Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  [
                    'Evaluation requested',
                    selected.case_status && selected.case_status !== 'DRAFT' ? 'Yes' : 'No',
                  ],
                  ['Evaluation date', shortDate(selected.evaluation?.created_at)],
                  ['Evaluator', selected.evaluation?.evaluator_name ?? 'Pending'],
                  ['Evaluated price', money(evaluationValue)],
                  ['Customer expected price', money(numberOrUndefined(form.customerExpectedValue))],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="text-right font-medium">{value}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Status</span>
                  {selected.case_status ? (
                    <StatusBadge value={selected.case_status} />
                  ) : (
                    <span>Not started</span>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card className="border-emerald-200 bg-emerald-50/30 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Estimated Exchange Value</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Based on the latest evaluator quote</p>
                <p className="mt-2 flex items-center text-3xl font-bold text-emerald-600">
                  <IndianRupee className="size-6" />
                  {evaluationValue == null
                    ? 'Pending'
                    : Number(evaluationValue).toLocaleString('en-IN')}
                </p>
                <p className="mt-3 rounded-md border border-emerald-200 bg-white/70 p-3 text-xs text-muted-foreground">
                  Final exchange value may vary after physical inspection and documentation
                  verification.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      ) : null}
      {busy ? (
        <div className="fixed bottom-5 right-5 flex items-center gap-2 rounded-md border bg-background px-4 py-3 text-sm shadow-lg">
          <Loader2 className="size-4 animate-spin" /> Saving exchange…
        </div>
      ) : null}
    </div>
  );
}
