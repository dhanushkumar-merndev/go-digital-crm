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
import { useEffect, useRef, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
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
import {
  isValidTestDriveRegistration,
  normalizeTestDriveRegistration,
  sanitizeTestDriveRegistrationInput,
  TEST_DRIVE_REGISTRATION_MAX_LENGTH,
  TEST_DRIVE_REGISTRATION_MIN_LENGTH,
} from './test-drive-registration';

function nextHour() {
  const value = new Date(Date.now() + 3_600_000);
  value.setMinutes(0, 0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function saveErrorMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String(error.message)
        : String(error ?? '');
  if (message.includes('TEST_DRIVE_VEHICLE_UNAVAILABLE'))
    return 'That vehicle is no longer available. Select another vehicle and try again.';
  if (message.includes('TEST_DRIVE_VEHICLE_SCHEDULE_CONFLICT'))
    return 'That vehicle already has a test drive during this time. Choose another slot or vehicle.';
  if (message.includes('TEST_DRIVE_CONSULTANT_SCHEDULE_CONFLICT'))
    return 'You already have a test drive during this time. Choose another slot.';
  if (message.includes('INVALID_TEST_DRIVE_INPUT'))
    return 'Check the registration, schedule, duration, and location values before saving.';
  if (message.includes('TEST_DRIVE_SCOPE_DENIED'))
    return 'The selected customer or vehicle is outside your assigned scope.';
  return 'Could not save the test drive. Refresh the available vehicles and try again.';
}

export function TestDriveCreateView({
  initialLeadId,
  initialLeadSearch,
  onCancel,
  onSaved,
}: {
  initialLeadId?: string;
  initialLeadSearch?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [leadSearch, setLeadSearch] = useState(() => initialLeadSearch?.slice(0, 160) ?? '');
  const [leadId, setLeadId] = useState(() => initialLeadId ?? '');
  const [branchId, setBranchId] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [stockUnitId, setStockUnitId] = useState('');
  const [scheduledAt, setScheduledAt] = useState(nextHour);
  const [duration, setDuration] = useState('60');
  const [registration, setRegistration] = useState('');
  const [startLocation, setStartLocation] = useState('');
  const [destination, setDestination] = useState('');
  const requestId = useRef<string | null>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const debouncedLeadSearch = useDebouncedValue(leadSearch, 300);
  const debouncedVehicleSearch = useDebouncedValue(vehicleSearch, 300);
  const leads = useQuery({
    queryKey: ['test-drive-lead-options', ...queryScope, debouncedLeadSearch],
    queryFn: ({ signal }) => fetchTestDriveLeadOptions(debouncedLeadSearch, signal),
    staleTime: 60_000,
  });
  const selectedLead = leads.data?.find((item) => item.lead_id === leadId);
  const resolvedBranchId = branchId || selectedLead?.branch_id || '';
  const vehicles = useQuery({
    queryKey: [
      'test-drive-vehicle-options',
      ...queryScope,
      resolvedBranchId,
      debouncedVehicleSearch,
    ],
    queryFn: ({ signal }) =>
      fetchTestDriveVehicleOptions(resolvedBranchId, debouncedVehicleSearch, signal),
    enabled: Boolean(resolvedBranchId),
    staleTime: 60_000,
  });
  const selectedVehicle = vehicles.data?.find((item) => item.stock_unit_id === stockUnitId);
  useEffect(() => {
    if (!stockUnitId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      registrationInputRef.current?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [stockUnitId]);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= crypto.randomUUID();
      return createTestDrive({
        leadId,
        stockUnitId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        expectedDurationMinutes: Number(duration),
        vehicleRegistration: normalizeTestDriveRegistration(registration),
        startLocation: startLocation.trim() ? { label: startLocation.trim() } : null,
        destination: destination.trim() ? { label: destination.trim() } : null,
        requestId: requestId.current,
      });
    },
    onSuccess: onSaved,
    onError: () => {
      // A changed retry must use a fresh idempotency key; otherwise the backend
      // correctly rejects the reused key with a different request fingerprint.
      requestId.current = null;
    },
  });
  const registrationValidationMessage = !registration.trim()
    ? 'Enter the vehicle registration number.'
    : !isValidTestDriveRegistration(registration)
      ? 'Use 4–24 letters, numbers, spaces, or hyphens only.'
      : null;
  const validationMessage = !leadId
    ? 'Select an assigned customer or lead.'
    : !selectedLead
      ? 'The selected customer is no longer available. Select the customer again.'
      : !stockUnitId
        ? 'Select an available test-drive vehicle.'
        : !selectedVehicle
          ? 'The selected vehicle is no longer available. Select another vehicle.'
          : !scheduledAt
            ? 'Choose a date and time.'
            : Number(duration) < 15
              ? 'Expected duration must be at least 15 minutes.'
              : registrationValidationMessage
                ? registrationValidationMessage
                : null;
  const valid = validationMessage === null;
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
          <AlertDescription>{saveErrorMessage(mutation.error)}</AlertDescription>
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
                    requestId.current = null;
                    setLeadId(value);
                    setStockUnitId('');
                    setVehicleSearch('');
                    setRegistration('');
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
                  disabled={!resolvedBranchId}
                  value={vehicleSearch}
                  placeholder={
                    resolvedBranchId
                      ? 'Search model, variant, VIN or chassis'
                      : 'Select customer first'
                  }
                  onChange={(e) => setVehicleSearch(e.target.value)}
                />
                <Select
                  disabled={!resolvedBranchId}
                  value={stockUnitId}
                  onValueChange={(value) => {
                    requestId.current = null;
                    setStockUnitId(value);
                    setRegistration('');
                  }}
                >
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
              <div className="space-y-2">
                <Label htmlFor="test-drive-registration-number">
                  Registration number <span aria-hidden="true">*</span>
                  <span className="sr-only"> (required)</span>
                </Label>
                <Input
                  ref={registrationInputRef}
                  id="test-drive-registration-number"
                  type="text"
                  required
                  value={registration}
                  minLength={TEST_DRIVE_REGISTRATION_MIN_LENGTH}
                  maxLength={TEST_DRIVE_REGISTRATION_MAX_LENGTH}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  className="cursor-text bg-background"
                  placeholder="KA 01 AB 1234"
                  aria-invalid={Boolean(stockUnitId && registrationValidationMessage)}
                  aria-describedby={
                    stockUnitId && registrationValidationMessage
                      ? 'test-drive-registration-help test-drive-registration-error'
                      : 'test-drive-registration-help'
                  }
                  onChange={(event) => {
                    requestId.current = null;
                    setRegistration(sanitizeTestDriveRegistrationInput(event.target.value));
                  }}
                />
                <p id="test-drive-registration-help" className="text-xs text-muted-foreground">
                  Enter the selected vehicle’s actual registration; it is not filled automatically.
                </p>
                {stockUnitId && registrationValidationMessage && (
                  <p
                    id="test-drive-registration-error"
                    className="text-xs font-medium text-destructive"
                    role="alert"
                  >
                    {registrationValidationMessage}
                  </p>
                )}
              </div>
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
            {validationMessage && (
              <p className="text-xs font-medium text-amber-700">{validationMessage}</p>
            )}
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
