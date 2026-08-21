'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Car,
  Clock3,
  Flag,
  MapPin,
  Play,
  Save,
  UserRound,
} from 'lucide-react';
import { useRef, useState } from 'react';
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
  createTestDrive,
  fetchTestDriveLeadOptions,
  fetchTestDriveVehicleOptions,
} from './test-drive-workspace-api';

function nextHour() {
  const value = new Date(Date.now() + 3_600_000);
  value.setMinutes(0, 0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function TestDriveCreateView({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [leadSearch, setLeadSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [stockUnitId, setStockUnitId] = useState('');
  const [scheduledAt, setScheduledAt] = useState(nextHour);
  const [duration, setDuration] = useState('60');
  const [registration, setRegistration] = useState('');
  const [startLocation, setStartLocation] = useState('');
  const [destination, setDestination] = useState('');
  const requestId = useRef<string | null>(null);
  const leads = useQuery({
    queryKey: ['test-drive-lead-options', useDebouncedValue(leadSearch, 300)],
    queryFn: ({ signal }) => fetchTestDriveLeadOptions(leadSearch, signal),
    staleTime: 60_000,
  });
  const vehicles = useQuery({
    queryKey: ['test-drive-vehicle-options', branchId, useDebouncedValue(vehicleSearch, 300)],
    queryFn: ({ signal }) => fetchTestDriveVehicleOptions(branchId, vehicleSearch, signal),
    enabled: Boolean(branchId),
    staleTime: 60_000,
  });
  const selectedLead = leads.data?.find((item) => item.lead_id === leadId);
  const selectedVehicle = vehicles.data?.find((item) => item.stock_unit_id === stockUnitId);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= crypto.randomUUID();
      return createTestDrive({
        leadId,
        stockUnitId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        expectedDurationMinutes: Number(duration),
        vehicleRegistration: registration.trim().toUpperCase(),
        startLocation: startLocation.trim() ? { label: startLocation.trim() } : null,
        destination: destination.trim() ? { label: destination.trim() } : null,
        requestId: requestId.current,
      });
    },
    onSuccess: onSaved,
  });
  const valid = Boolean(
    leadId &&
    stockUnitId &&
    scheduledAt &&
    Number(duration) >= 15 &&
    /^[A-Z0-9 -]{4,24}$/i.test(registration.trim()),
  );
  const submit = () => valid && mutation.mutate();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button onClick={onCancel} className="mb-2 flex items-center gap-1 text-sm text-primary">
            <ArrowLeft className="size-4" /> Test Drives
          </button>
          <h1 className="text-2xl font-bold">New Test Drive</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Schedule a test drive using an assigned opportunity and an available branch vehicle.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={submit}>
            <Save className="size-4" /> {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not save the test drive. The vehicle may no longer be available or its schedule
            may conflict.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_360px]">
        <div className="space-y-4">
          <Section icon={UserRound} title="1. Customer">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Find assigned customer or lead">
                <Input
                  value={leadSearch}
                  placeholder="Search customer, phone or interested model"
                  onChange={(e) => setLeadSearch(e.target.value)}
                />
                <Select
                  value={leadId}
                  onValueChange={(value) => {
                    setLeadId(value);
                    setStockUnitId('');
                    setBranchId(
                      leads.data?.find((item) => item.lead_id === value)?.branch_id ?? '',
                    );
                  }}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={leads.isPending ? 'Loading…' : 'Select opportunity'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {leads.data?.map((item) => (
                      <SelectItem key={item.lead_id} value={item.lead_id}>
                        {item.customer_name} · {item.phone ?? 'No phone'} ·{' '}
                        {item.interested_model ?? 'Vehicle TBD'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Mobile">
                <Input
                  readOnly
                  value={selectedLead?.phone ?? ''}
                  placeholder="Filled from customer record"
                />
              </Field>
            </div>
          </Section>
          <Section icon={Car} title="2. Vehicle">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Available test-drive vehicle">
                <Input
                  disabled={!branchId}
                  value={vehicleSearch}
                  placeholder={
                    branchId ? 'Search model, variant, VIN or chassis' : 'Select customer first'
                  }
                  onChange={(e) => setVehicleSearch(e.target.value)}
                />
                <Select disabled={!branchId} value={stockUnitId} onValueChange={setStockUnitId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={vehicles.isPending ? 'Loading…' : 'Select available vehicle'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {vehicles.data?.map((item) => (
                      <SelectItem key={item.stock_unit_id} value={item.stock_unit_id}>
                        {item.brand_name} {item.model_name} {item.variant_name} ·{' '}
                        {item.color ?? 'Colour N/A'} · {item.vin}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Registration number">
                <Input
                  required
                  value={registration}
                  maxLength={24}
                  placeholder="KA 01 AB 1234"
                  onChange={(e) => setRegistration(e.target.value.toUpperCase())}
                />
              </Field>
            </div>
          </Section>
          <Section icon={CalendarDays} title="3. Schedule">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Date and time">
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </Field>
              <Field label="Expected duration">
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[30, 45, 60, 90, 120].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value} minutes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>
          <Section icon={MapPin} title="4. Location">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Start location">
                <Input
                  value={startLocation}
                  maxLength={240}
                  placeholder="Showroom entrance"
                  onChange={(e) => setStartLocation(e.target.value)}
                />
              </Field>
              <Field label="Customer / destination location">
                <Input
                  value={destination}
                  maxLength={240}
                  placeholder="Planned destination"
                  onChange={(e) => setDestination(e.target.value)}
                />
              </Field>
            </div>
          </Section>
        </div>
        <Card className="sticky top-20 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Flag className="size-4 text-blue-600" /> Test Drive Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <Summary
              icon={UserRound}
              label="Customer"
              value={selectedLead?.customer_name ?? 'Select a customer'}
              sub={selectedLead?.phone ?? undefined}
            />
            <Summary
              icon={Car}
              label="Vehicle"
              value={
                selectedVehicle
                  ? `${selectedVehicle.brand_name} ${selectedVehicle.model_name}`
                  : 'Select a vehicle'
              }
              sub={
                selectedVehicle
                  ? `${selectedVehicle.variant_name} · ${selectedVehicle.color ?? 'Colour N/A'}`
                  : undefined
              }
            />
            <Summary
              icon={Building2}
              label="Branch"
              value={selectedLead?.branch_name ?? 'Assigned branch'}
            />
            <Summary
              icon={Clock3}
              label="Schedule"
              value={
                scheduledAt
                  ? new Intl.DateTimeFormat('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(scheduledAt))
                  : 'Select date and time'
              }
              sub={`${duration} minutes`}
            />
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700">
              Only inventory currently available for test drives in the selected lead’s branch is
              shown.
            </div>
            <Button className="w-full" disabled={!valid || mutation.isPending} onClick={submit}>
              <Play className="size-4" /> Save test drive
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof UserRound;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
            <Icon className="size-4" />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Summary({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof UserRound;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex gap-3 border-b pb-4 last:border-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 font-semibold">{value}</p>
        {sub && <p className="text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}
