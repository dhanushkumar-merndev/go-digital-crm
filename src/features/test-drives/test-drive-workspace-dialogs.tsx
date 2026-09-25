'use client';

import { useMutation, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LocateFixed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import {
  Map,
  MapControls,
  MapMarker,
  MapRoute,
  MarkerContent,
  MarkerLabel,
} from '@/components/ui/map';
import { SearchSelect } from '@/components/ui/search-select';
import { salesConsultantKeys } from '@/features/sales-consultant/sales-consultant-cache';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  flattenOptionPages,
  optionPagesQueryOptions,
  optionQueryOptions,
} from '@/lib/query/option-query';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import {
  cancelTestDrive,
  createTestDrive,
  fetchTestDriveLeadOptions,
  fetchTestDriveVehicleOptions,
  finalizeTestDriveRoute,
  recordTestDriveAnchor,
  saveTestDriveFeedback,
  type TestDriveAnchorKind,
  type TestDriveRecord,
} from './test-drive-workspace-api';
import { isTestDriveVersionConflict } from './test-drive-workspace-query';
import {
  isValidTestDriveRegistration,
  normalizeTestDriveRegistration,
  sanitizeTestDriveRegistrationInput,
  TEST_DRIVE_REGISTRATION_MAX_LENGTH,
  TEST_DRIVE_REGISTRATION_MIN_LENGTH,
} from './test-drive-registration';

function nextLocalHour() {
  const value = new Date(Date.now() + 60 * 60 * 1000);
  value.setMinutes(0, 0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function mutationMessage(error: unknown, fallback: string) {
  if (isTestDriveVersionConflict(error))
    return 'This test drive changed elsewhere. Close this dialog, refresh, and try again.';
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (message.includes('SCHEDULE_CONFLICT'))
      return 'That vehicle is already scheduled during this time window.';
    if (message.includes('VEHICLE_UNAVAILABLE'))
      return 'The selected vehicle is no longer available.';
    if (message.includes('INVALID_END_TRANSITION'))
      return 'This drive cannot be completed with these details. Refresh and verify the end time and odometer; if it is a stale interrupted drive, cancel it from the Active tab instead.';
    if (message.includes('INVALID_START_TRANSITION'))
      return 'This drive is no longer ready to start. Refresh the page to see its current status.';
    if (message.includes('TEST_DRIVE_CONSULTANT_ALREADY_ACTIVE'))
      return 'You already have an active test drive. Open the Active tab and complete or cancel it before starting another.';
    if (message.includes('TEST_DRIVE_CANCELLATION_NOT_ALLOWED'))
      return 'Only a scheduled or active test drive can be cancelled.';
    if (message.includes('TEST_DRIVE_ASSIGNEE_REQUIRED'))
      return 'Only the consultant assigned to this test drive can progress it.';
  }
  return fallback;
}

function TestDriveRoutePreview({ record }: { record: TestDriveRecord }) {
  const anchors = [record.start_anchor, record.reached_anchor, record.end_anchor].filter(
    (anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor),
  );
  if (anchors.length < 2) return null;
  const center: [number, number] = [
    anchors.reduce((total, anchor) => total + anchor.longitude, 0) / anchors.length,
    anchors.reduce((total, anchor) => total + anchor.latitude, 0) / anchors.length,
  ];
  return (
    <div
      className="mt-4 overflow-hidden rounded-md border"
      aria-label="Simplified test-drive route preview"
    >
      <Map className="h-56" center={center} zoom={12}>
        <MapRoute
          id={`test-drive-route-${record.id}`}
          coordinates={anchors.map((anchor) => [anchor.longitude, anchor.latitude])}
          color="hsl(var(--primary))"
          width={4}
          interactive={false}
        />
        {anchors.map((anchor, index) => {
          const label = index === 0 ? 'Start' : index === anchors.length - 1 ? 'End' : 'Reached';
          return (
            <MapMarker
              key={`${label}-${anchor.recorded_at}`}
              longitude={anchor.longitude}
              latitude={anchor.latitude}
            >
              <MarkerContent>
                <span className="block size-3 rounded-full border-2 border-background bg-primary shadow-sm" />
              </MarkerContent>
              <MarkerLabel>{label}</MarkerLabel>
            </MapMarker>
          );
        })}
        <MapControls position="top-right" showCompass showFullscreen />
      </Map>
    </div>
  );
}

export function TestDriveScheduleDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const workspaceSession = useWorkspaceSession();
  const queryScope = workspaceQueryScope(workspaceSession);
  const [leadSearch, setLeadSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [stockUnitId, setStockUnitId] = useState('');
  const [scheduledAt, setScheduledAt] = useState(nextLocalHour);
  const [duration, setDuration] = useState('60');
  const [registration, setRegistration] = useState('');
  const [startLocation, setStartLocation] = useState('');
  const [destination, setDestination] = useState('');
  const requestId = useRef<string | null>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const debouncedLeadSearch = useDebouncedValue(leadSearch, 300);
  const debouncedVehicleSearch = useDebouncedValue(vehicleSearch, 300);
  const leads = useInfiniteQuery(
    optionPagesQueryOptions({
      queryKey: [
        ...salesConsultantKeys.testDriveLeadOptions(queryScope),
        'pages',
        debouncedLeadSearch,
      ],
      fetchRows: (offset, limit, signal) =>
        fetchTestDriveLeadOptions(debouncedLeadSearch, signal, { offset, limit }),
      enabled: open,
    }),
  );
  const leadsRows = flattenOptionPages(leads.data);
  const vehicles = useQuery(
    optionQueryOptions({
      queryKey: [
        ...salesConsultantKeys.testDriveVehicleOptions(queryScope),
        branchId,
        debouncedVehicleSearch,
      ],
      queryFn: ({ signal }) =>
        fetchTestDriveVehicleOptions(branchId, debouncedVehicleSearch, signal),
      enabled: open && Boolean(branchId),
    }),
  );
  useEffect(() => {
    if (!open || !stockUnitId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      registrationInputRef.current?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [open, stockUnitId]);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
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
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const durationValue = Number(duration);
  const validRegistration = isValidTestDriveRegistration(registration);
  const registrationValidationMessage = !registration.trim()
    ? 'Enter the vehicle registration number.'
    : !validRegistration
      ? 'Use 4–24 letters, numbers, spaces, or hyphens only.'
      : null;
  const validSchedule = Boolean(scheduledAt) && !Number.isNaN(new Date(scheduledAt).getTime());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Schedule test drive</DialogTitle>
          <DialogDescription>
            Select an in-scope opportunity and an available vehicle from the same branch.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="test-drive-lead-search">Customer opportunity</Label>
              <SearchSelect
                id="test-drive-lead-search"
                value={leadId}
                search={leadSearch}
                onSearchChange={setLeadSearch}
                options={leadsRows?.map((lead) => ({
                  value: lead.lead_id,
                  label: lead.customer_name,
                  description: [
                    lead.phone ?? 'No phone',
                    lead.interested_model ?? 'Vehicle TBD',
                    lead.branch_name,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                isPending={leads.isPending}
                isFetching={leads.isFetching}
                hasMore={leads.hasNextPage}
                onLoadMore={() => void leads.fetchNextPage()}
                isLoadingMore={leads.isFetchingNextPage}
                isError={leads.isError}
                placeholder="Select opportunity"
                searchPlaceholder="Search customer, phone or interested model"
                emptyMessage="No assigned customer or lead matches this search."
                aria-label="Customer opportunity"
                onValueChange={(value) => {
                  requestId.current = null;
                  setLeadId(value);
                  setStockUnitId('');
                  setVehicleSearch('');
                  setRegistration('');
                  setBranchId(leadsRows?.find((lead) => lead.lead_id === value)?.branch_id ?? '');
                }}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="test-drive-vehicle-search">Test-drive vehicle</Label>
              <SearchSelect
                id="test-drive-vehicle-search"
                value={stockUnitId}
                disabled={!branchId}
                search={vehicleSearch}
                onSearchChange={setVehicleSearch}
                options={vehicles.data?.map((vehicle) => ({
                  value: vehicle.stock_unit_id,
                  label: `${vehicle.brand_name} ${vehicle.model_name} ${vehicle.variant_name}`,
                  description: [vehicle.color ?? 'Colour N/A', vehicle.vin]
                    .filter(Boolean)
                    .join(' · '),
                }))}
                isPending={vehicles.isPending}
                isFetching={vehicles.isFetching}
                isError={vehicles.isError}
                placeholder="Select available vehicle"
                disabledMessage="Select customer first"
                searchPlaceholder="Search VIN, chassis, model or variant"
                emptyMessage="No test-drive vehicle is available in this branch right now."
                aria-label="Test-drive vehicle"
                onValueChange={(value) => {
                  requestId.current = null;
                  setStockUnitId(value);
                  setRegistration('');
                }}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="test-drive-schedule">Date and time</Label>
              <Input
                id="test-drive-schedule"
                type="datetime-local"
                value={scheduledAt}
                required
                onChange={(event) => {
                  requestId.current = null;
                  setScheduledAt(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="test-drive-duration">Duration (minutes)</Label>
              <Input
                id="test-drive-duration"
                type="number"
                min={15}
                max={480}
                value={duration}
                required
                onChange={(event) => {
                  requestId.current = null;
                  setDuration(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="test-drive-registration">
              Registration <span aria-hidden="true">*</span>
              <span className="sr-only"> (required)</span>
            </Label>
            <Input
              ref={registrationInputRef}
              id="test-drive-registration"
              type="text"
              value={registration}
              minLength={TEST_DRIVE_REGISTRATION_MIN_LENGTH}
              maxLength={TEST_DRIVE_REGISTRATION_MAX_LENGTH}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              className="cursor-text bg-background"
              placeholder="KA 01 AB 1234"
              required
              aria-invalid={Boolean(stockUnitId && registrationValidationMessage)}
              aria-describedby={
                stockUnitId && registrationValidationMessage
                  ? 'test-drive-dialog-registration-help test-drive-dialog-registration-error'
                  : 'test-drive-dialog-registration-help'
              }
              onChange={(event) => {
                requestId.current = null;
                setRegistration(sanitizeTestDriveRegistrationInput(event.target.value));
              }}
            />
            <p id="test-drive-dialog-registration-help" className="text-xs text-muted-foreground">
              Enter the selected vehicle’s actual registration; it is not filled automatically.
            </p>
            {stockUnitId && registrationValidationMessage && (
              <p
                id="test-drive-dialog-registration-error"
                className="text-xs font-medium text-destructive"
                role="alert"
              >
                {registrationValidationMessage}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="test-drive-start-location">Start location (optional)</Label>
              <Input
                id="test-drive-start-location"
                value={startLocation}
                maxLength={240}
                placeholder="Showroom entrance"
                onChange={(event) => {
                  requestId.current = null;
                  setStartLocation(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="test-drive-destination">Destination (optional)</Label>
              <Input
                id="test-drive-destination"
                value={destination}
                maxLength={240}
                placeholder="Planned destination"
                onChange={(event) => {
                  requestId.current = null;
                  setDestination(event.target.value);
                }}
              />
            </div>
          </div>
          {(leads.isError || vehicles.isError || mutation.isError) && (
            <Alert variant="destructive">
              <AlertDescription>
                {mutation.isError
                  ? mutationMessage(
                      mutation.error,
                      'The test drive could not be scheduled. Check the customer, vehicle, and schedule.',
                    )
                  : 'Available opportunity or vehicle options could not be loaded.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                !leadId ||
                !stockUnitId ||
                !validSchedule ||
                !validRegistration ||
                !Number.isInteger(durationValue) ||
                durationValue < 15 ||
                durationValue > 480
              }
            >
              {mutation.isPending ? 'Scheduling…' : 'Schedule test drive'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TestDriveCancelDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record: TestDriveRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const active = record.status === 'ACTIVE';
  const [reason, setReason] = useState('');
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      return cancelTestDrive({
        testDriveId: record.id,
        expectedVersion: record.version,
        reason,
        requestId: requestId.current,
      });
    },
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
          <DialogTitle>{active ? 'Cancel active test drive' : 'Cancel test drive'}</DialogTitle>
          <DialogDescription>
            {active
              ? `Stop and cancel ${record.customer_name}'s active drive without marking it completed. Its recorded anchors remain in the audit history.`
              : `Cancel ${record.customer_name}'s scheduled drive. The record remains in history.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="test-drive-cancellation-reason">Reason</Label>
            <Textarea
              id="test-drive-cancellation-reason"
              value={reason}
              minLength={5}
              maxLength={1000}
              rows={4}
              required
              onChange={(event) => {
                requestId.current = null;
                setReason(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {mutationMessage(
                  mutation.error,
                  active
                    ? 'The active test drive could not be cancelled.'
                    : 'The scheduled test drive could not be cancelled.',
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {active ? 'Keep active' : 'Keep scheduled'}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending || reason.trim().length < 5}
            >
              {mutation.isPending
                ? 'Cancelling…'
                : active
                  ? 'Cancel active drive'
                  : 'Cancel test drive'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TestDriveAnchorDialog({
  kind,
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  kind: TestDriveAnchorKind;
  record: TestDriveRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [odometer, setOdometer] = useState(() =>
    kind === 'end' && record.start_odometer !== null ? String(record.start_odometer) : '',
  );
  const [locationError, setLocationError] = useState('');
  const [locating, setLocating] = useState(false);
  const requestId = useRef<string | null>(null);
  const recordedAt = useRef<string | null>(null);
  const requiresOdometer = kind !== 'reached';
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      recordedAt.current ??= new Date().toISOString();
      return recordTestDriveAnchor({
        testDriveId: record.id,
        kind,
        latitude: Number(latitude),
        longitude: Number(longitude),
        recordedAt: recordedAt.current,
        odometer: requiresOdometer ? Number(odometer) : null,
        expectedVersion: record.version,
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      recordedAt.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const locate = () => {
    if (!globalThis.navigator?.geolocation) {
      setLocationError('Location is unavailable in this browser. Enter coordinates manually.');
      return;
    }
    setLocating(true);
    setLocationError('');
    globalThis.navigator.geolocation.getCurrentPosition(
      (position) => {
        requestId.current = null;
        recordedAt.current = null;
        setLatitude(position.coords.latitude.toFixed(7));
        setLongitude(position.coords.longitude.toFixed(7));
        setLocating(false);
      },
      () => {
        setLocationError('Location permission was denied or no current location was available.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  };
  const latitudeValue = Number(latitude);
  const longitudeValue = Number(longitude);
  const odometerValue = Number(odometer);
  const validCoordinates =
    latitude.trim() !== '' &&
    longitude.trim() !== '' &&
    latitudeValue >= -90 &&
    latitudeValue <= 90 &&
    longitudeValue >= -180 &&
    longitudeValue <= 180;
  const validOdometer =
    !requiresOdometer ||
    (odometer.trim() !== '' &&
      Number.isInteger(odometerValue) &&
      odometerValue >= 0 &&
      odometerValue <= 2_000_000 &&
      (kind !== 'end' || record.start_odometer === null || odometerValue >= record.start_odometer));
  const odometerError =
    requiresOdometer && odometer.trim() !== '' && !validOdometer
      ? kind === 'end' && record.start_odometer !== null && odometerValue < record.start_odometer
        ? `End odometer must be at least ${record.start_odometer.toLocaleString()} km.`
        : 'Enter a whole odometer value between 0 and 2,000,000 km.'
      : '';
  const titles: Record<TestDriveAnchorKind, string> = {
    start: 'Start test drive',
    reached: 'Record destination reached',
    end: 'Complete test drive',
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[kind]}</DialogTitle>
          <DialogDescription>
            Capture a permanent route anchor for {record.customer_name}. Active route tracking
            remains a mobile workflow.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={locating}
            onClick={locate}
          >
            <LocateFixed className="size-4" />
            {locating ? 'Getting current location…' : 'Use current location'}
          </Button>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`test-drive-${kind}-latitude`}>Latitude</Label>
              <Input
                id={`test-drive-${kind}-latitude`}
                type="number"
                step="any"
                min={-90}
                max={90}
                value={latitude}
                required
                onChange={(event) => {
                  requestId.current = null;
                  recordedAt.current = null;
                  setLatitude(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`test-drive-${kind}-longitude`}>Longitude</Label>
              <Input
                id={`test-drive-${kind}-longitude`}
                type="number"
                step="any"
                min={-180}
                max={180}
                value={longitude}
                required
                onChange={(event) => {
                  requestId.current = null;
                  recordedAt.current = null;
                  setLongitude(event.target.value);
                }}
              />
            </div>
          </div>
          {requiresOdometer && (
            <div className="grid gap-2">
              <Label htmlFor={`test-drive-${kind}-odometer`}>
                {kind === 'start' ? 'Start' : 'End'} odometer (km)
              </Label>
              <Input
                id={`test-drive-${kind}-odometer`}
                type="number"
                min={kind === 'end' ? (record.start_odometer ?? 0) : 0}
                max={2_000_000}
                value={odometer}
                required
                aria-invalid={Boolean(odometerError)}
                onChange={(event) => {
                  requestId.current = null;
                  recordedAt.current = null;
                  setOdometer(event.target.value);
                }}
              />
              {kind === 'end' && record.start_odometer !== null && !odometerError && (
                <p className="text-xs text-muted-foreground">
                  Start odometer: {record.start_odometer.toLocaleString()} km
                </p>
              )}
              {odometerError && <p className="text-xs text-destructive">{odometerError}</p>}
            </div>
          )}
          {(locationError || mutation.isError) && (
            <Alert variant="destructive">
              <AlertDescription>
                {locationError ||
                  mutationMessage(mutation.error, 'The route anchor could not be recorded.')}
              </AlertDescription>
            </Alert>
          )}
          {kind === 'end' && (
            <p className="text-xs text-muted-foreground">
              After completion, finalize the simplified route from the Completed tab before saving
              customer feedback.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || !validCoordinates || !validOdometer}
            >
              {mutation.isPending ? 'Saving…' : titles[kind]}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TestDriveFinalizeDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record: TestDriveRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const requestId = useRef<string | null>(null);
  const anchors = [record.start_anchor, record.reached_anchor, record.end_anchor].filter(
    (anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor),
  );
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      return finalizeTestDriveRoute({
        testDriveId: record.id,
        expectedVersion: record.version,
        routePoints: anchors.map((anchor, index) => ({
          sequenceNo: index + 1,
          latitude: anchor.latitude,
          longitude: anchor.longitude,
          recordedAt: anchor.recorded_at,
        })),
        requestId: requestId.current,
      });
    },
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
          <DialogTitle>Finalize route summary</DialogTitle>
          <DialogDescription>
            Permanently store the simplified {anchors.length}-anchor route for{' '}
            {record.customer_name}. This is safe to retry if the request is interrupted.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 rounded-md border bg-muted/30 p-4 text-sm">
          <p className="font-medium">
            {record.vehicle_registration ?? record.vin ?? 'Test-drive vehicle'}
          </p>
          <p className="mt-1 text-muted-foreground">
            {record.distance_meters === null
              ? 'Distance unavailable'
              : `${(record.distance_meters / 1000).toFixed(1)} km`}{' '}
            ·{' '}
            {record.duration_seconds === null
              ? 'Duration unavailable'
              : `${Math.round(record.duration_seconds / 60)} min`}
          </p>
        </div>
        <TestDriveRoutePreview record={record} />
        {mutation.isError && (
          <Alert className="mt-4" variant="destructive">
            <AlertDescription>
              {mutationMessage(mutation.error, 'The route summary could not be finalized.')}
            </AlertDescription>
          </Alert>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            disabled={mutation.isPending || !record.start_anchor || !record.end_anchor}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Finalizing…' : 'Finalize route'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ratings = [
  ['driving', 'Driving experience'],
  ['comfort', 'Comfort'],
  ['features', 'Features'],
  ['performance', 'Performance'],
  ['price', 'Price perception'],
  ['overall', 'Overall rating'],
] as const;

export function TestDriveFeedbackDialog({
  record,
  open,
  onOpenChange,
  onSaved,
}: {
  record: TestDriveRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [ratingValues, setRatingValues] = useState<Record<(typeof ratings)[number][0], string>>({
    driving: '5',
    comfort: '5',
    features: '5',
    performance: '5',
    price: '5',
    overall: '5',
  });
  const [purchaseIntent, setPurchaseIntent] = useState('INTERESTED');
  const [competitor, setCompetitor] = useState('');
  const [comments, setComments] = useState('');
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
      return saveTestDriveFeedback({
        testDriveId: record.id,
        expectedVersion: record.version,
        drivingExperienceRating: Number(ratingValues.driving),
        comfortRating: Number(ratingValues.comfort),
        featuresRating: Number(ratingValues.features),
        performanceRating: Number(ratingValues.performance),
        pricePerceptionRating: Number(ratingValues.price),
        overallRating: Number(ratingValues.overall),
        comments,
        competitorCompared: competitor,
        purchaseIntent,
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Test-drive feedback</DialogTitle>
          <DialogDescription>
            Record structured feedback for {record.customer_name} after the route is finalized.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-5 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {ratings.map(([key, label]) => (
              <div key={key} className="grid gap-2">
                <Label>{label}</Label>
                <Select
                  value={ratingValues[key]}
                  onValueChange={(value) => {
                    requestId.current = null;
                    setRatingValues((current) => ({ ...current, [key]: value }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value} / 5
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="grid gap-2">
            <Label>Purchase intent</Label>
            <Select
              value={purchaseIntent}
              onValueChange={(value) => {
                requestId.current = null;
                setPurchaseIntent(value);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HIGHLY_INTERESTED">Highly interested</SelectItem>
                <SelectItem value="INTERESTED">Interested</SelectItem>
                <SelectItem value="CONSIDERING">Considering</SelectItem>
                <SelectItem value="NOT_INTERESTED">Not interested</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="test-drive-competitor">Competitor compared (optional)</Label>
            <Input
              id="test-drive-competitor"
              value={competitor}
              maxLength={160}
              onChange={(event) => {
                requestId.current = null;
                setCompetitor(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="test-drive-feedback-comments">Comments (optional)</Label>
            <Textarea
              id="test-drive-feedback-comments"
              value={comments}
              maxLength={2000}
              rows={4}
              onChange={(event) => {
                requestId.current = null;
                setComments(event.target.value);
              }}
            />
          </div>
          {mutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {mutationMessage(mutation.error, 'The customer feedback could not be saved.')}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save feedback'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
