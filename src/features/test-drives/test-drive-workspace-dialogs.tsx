'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { LocateFixed } from 'lucide-react';
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
import {
  Map,
  MapControls,
  MapMarker,
  MapRoute,
  MarkerContent,
  MarkerLabel,
} from '@/components/ui/map';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
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
  const debouncedLeadSearch = useDebouncedValue(leadSearch, 300);
  const debouncedVehicleSearch = useDebouncedValue(vehicleSearch, 300);
  const leads = useQuery({
    queryKey: ['test-drive-lead-options', debouncedLeadSearch],
    queryFn: ({ signal }) => fetchTestDriveLeadOptions(debouncedLeadSearch, signal),
    enabled: open,
    staleTime: 60_000,
  });
  const vehicles = useQuery({
    queryKey: ['test-drive-vehicle-options', branchId, debouncedVehicleSearch],
    queryFn: ({ signal }) => fetchTestDriveVehicleOptions(branchId, debouncedVehicleSearch, signal),
    enabled: open && Boolean(branchId),
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: () => {
      requestId.current ??= globalThis.crypto.randomUUID();
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
    onSuccess: () => {
      requestId.current = null;
      onSaved();
      onOpenChange(false);
    },
  });
  const durationValue = Number(duration);
  const validRegistration = /^[A-Z0-9 -]{4,24}$/i.test(registration.trim());
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
              <Input
                id="test-drive-lead-search"
                value={leadSearch}
                maxLength={160}
                placeholder="Search customer, phone or interested model"
                onChange={(event) => setLeadSearch(event.target.value)}
              />
            </div>
            <Select
              value={leadId}
              onValueChange={(value) => {
                requestId.current = null;
                setLeadId(value);
                setStockUnitId('');
                setBranchId(leads.data?.find((lead) => lead.lead_id === value)?.branch_id ?? '');
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={leads.isPending ? 'Loading…' : 'Select opportunity'} />
              </SelectTrigger>
              <SelectContent>
                {(leads.data ?? []).map((lead) => (
                  <SelectItem key={lead.lead_id} value={lead.lead_id}>
                    {lead.customer_name} · {lead.interested_model ?? 'Vehicle TBD'} ·{' '}
                    {lead.branch_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="test-drive-vehicle-search">Test-drive vehicle</Label>
              <Input
                id="test-drive-vehicle-search"
                value={vehicleSearch}
                maxLength={120}
                disabled={!branchId}
                placeholder={
                  branchId ? 'Search VIN, chassis, model or variant' : 'Select customer first'
                }
                onChange={(event) => setVehicleSearch(event.target.value)}
              />
            </div>
            <Select
              value={stockUnitId}
              disabled={!branchId}
              onValueChange={(value) => {
                requestId.current = null;
                setStockUnitId(value);
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={vehicles.isPending ? 'Loading…' : 'Select available vehicle'}
                />
              </SelectTrigger>
              <SelectContent>
                {(vehicles.data ?? []).map((vehicle) => (
                  <SelectItem key={vehicle.stock_unit_id} value={vehicle.stock_unit_id}>
                    {vehicle.brand_name} {vehicle.model_name} {vehicle.variant_name} · {vehicle.vin}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Label htmlFor="test-drive-registration">Registration</Label>
            <Input
              id="test-drive-registration"
              value={registration}
              minLength={4}
              maxLength={24}
              placeholder="KA 01 AB 1234"
              required
              onChange={(event) => {
                requestId.current = null;
                setRegistration(event.target.value.toUpperCase());
              }}
            />
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
          <DialogTitle>Cancel test drive</DialogTitle>
          <DialogDescription>
            Cancel {record.customer_name}&apos;s scheduled drive. The record remains in history.
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
                  'The scheduled test drive could not be cancelled.',
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Keep scheduled
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={mutation.isPending || reason.trim().length < 5}
            >
              {mutation.isPending ? 'Cancelling…' : 'Cancel test drive'}
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
  const [odometer, setOdometer] = useState('');
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
                onChange={(event) => {
                  requestId.current = null;
                  recordedAt.current = null;
                  setOdometer(event.target.value);
                }}
              />
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
