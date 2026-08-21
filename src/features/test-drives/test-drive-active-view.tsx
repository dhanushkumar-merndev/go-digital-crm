'use client';

import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Flag,
  Gauge,
  MapPin,
  Navigation,
  Phone,
  Route,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Map,
  MapControls,
  MapMarker,
  MapRoute,
  MarkerContent,
  MarkerLabel,
} from '@/components/ui/map';
import type { TestDriveAnchorKind, TestDriveRecord } from './test-drive-workspace-api';

function formatDate(value: string | null) {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function locationLabel(value: TestDriveRecord['start_location']) {
  return value?.label || 'Location not recorded';
}

export function TestDriveActiveView({
  record,
  onBack,
  onAnchor,
}: {
  record: TestDriveRecord;
  onBack: () => void;
  onAnchor: (kind: TestDriveAnchorKind) => void;
}) {
  const anchors = [record.start_anchor, record.reached_anchor, record.end_anchor].filter(
    (anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor),
  );
  const center: [number, number] | undefined = anchors.length
    ? [
        anchors.reduce((sum, item) => sum + item.longitude, 0) / anchors.length,
        anchors.reduce((sum, item) => sum + item.latitude, 0) / anchors.length,
      ]
    : undefined;
  const duration = record.duration_seconds;
  const averageSpeed =
    duration && record.distance_meters ? record.distance_meters / 1000 / (duration / 3600) : null;
  const events = [
    {
      at: record.scheduled_at,
      title: 'Test drive scheduled',
      detail: locationLabel(record.start_location),
      icon: Clock3,
    },
    record.started_at
      ? {
          at: record.started_at,
          title: 'Test drive started',
          detail: locationLabel(record.start_location),
          icon: Navigation,
        }
      : null,
    record.reached_at
      ? {
          at: record.reached_at,
          title: 'Destination reached',
          detail: locationLabel(record.destination),
          icon: MapPin,
        }
      : null,
    record.completed_at
      ? {
          at: record.completed_at,
          title: 'Test drive completed',
          detail: record.end_odometer
            ? `End odometer ${record.end_odometer.toLocaleString()} km`
            : 'Completion recorded',
          icon: Flag,
        }
      : null,
  ].filter(Boolean) as { at: string; title: string; detail: string; icon: typeof Clock3 }[];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button className="mb-2 flex items-center gap-1 text-sm text-primary" onClick={onBack}>
            <ArrowLeft className="size-4" /> Test Drives
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Active Test Drive</h1>
            <Badge className="bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
              {record.status === 'ACTIVE' ? 'In progress' : record.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Live operational details from the recorded test-drive session.
          </p>
        </div>
        <Button variant="outline" onClick={onBack}>
          Back to list
        </Button>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_360px]">
        <div className="space-y-4">
          <Card className="overflow-hidden shadow-none">
            <CardContent className="p-0">
              {center ? (
                <Map className="h-[430px]" center={center} zoom={13}>
                  {anchors.length > 1 && (
                    <MapRoute
                      id={`active-route-${record.id}`}
                      coordinates={anchors.map((item) => [item.longitude, item.latitude])}
                      color="#2563eb"
                      width={5}
                      interactive={false}
                    />
                  )}
                  {anchors.map((anchor, index) => (
                    <MapMarker
                      key={anchor.recorded_at}
                      longitude={anchor.longitude}
                      latitude={anchor.latitude}
                    >
                      <MarkerContent>
                        <span className="block size-4 rounded-full border-2 border-white bg-blue-600 shadow" />
                      </MarkerContent>
                      <MarkerLabel>
                        {index === 0
                          ? 'Start'
                          : index === anchors.length - 1
                            ? 'Current / end'
                            : 'Destination'}
                      </MarkerLabel>
                    </MapMarker>
                  ))}
                  <MapControls position="top-right" showZoom showCompass showFullscreen />
                </Map>
              ) : (
                <div className="grid h-[430px] place-items-center bg-slate-50 text-center">
                  <div>
                    <MapPin className="mx-auto size-9 text-muted-foreground" />
                    <p className="mt-3 font-medium">Waiting for the first GPS anchor</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The map appears after the consultant starts the drive with location access.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                'Distance covered',
                record.distance_meters == null
                  ? 'Pending'
                  : `${(record.distance_meters / 1000).toFixed(1)} km`,
                Route,
              ],
              [
                'Elapsed duration',
                duration == null ? 'Pending' : `${Math.floor(duration / 60)} min`,
                Clock3,
              ],
              [
                'Average speed',
                averageSpeed == null ? 'Pending' : `${averageSpeed.toFixed(1)} km/h`,
                Gauge,
              ],
              [
                'Route status',
                record.route_finalized_at ? 'Finalized' : record.gps_status.replaceAll('_', ' '),
                CheckCircle2,
              ],
            ].map(([name, value, Icon]) => (
              <Card key={String(name)} className="shadow-none">
                <CardContent className="flex items-center gap-3 p-4">
                  <span className="grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <p className="text-xs text-muted-foreground">{name as string}</p>
                    <p className="font-semibold capitalize">{value as string}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
        <Card className="h-fit shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Test Drive Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Customer</p>
              <p className="mt-1 font-semibold">{record.customer_name}</p>
              <p>{record.phone ?? 'No phone'}</p>
            </div>
            <div className="border-t pt-4">
              <p className="text-xs text-muted-foreground">Sales consultant</p>
              <p className="mt-1 font-semibold">{record.assigned_user_name}</p>
              <p>{record.branch_name}</p>
            </div>
            <div className="border-t pt-4">
              <p className="text-xs text-muted-foreground">Vehicle</p>
              <p className="mt-1 font-semibold">
                {[record.brand_name, record.model_name].filter(Boolean).join(' ')}
              </p>
              <p>
                {record.variant_name} {record.color ? `· ${record.color}` : ''}
              </p>
              <p className="mt-1">{record.vehicle_registration}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t pt-4">
              <div>
                <p className="text-xs text-muted-foreground">Start time</p>
                <p className="mt-1 font-medium">{formatDate(record.started_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Start KM</p>
                <p className="mt-1 font-medium">
                  {record.start_odometer?.toLocaleString() ?? 'Pending'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 border-t pt-4">
              {record.phone && (
                <Button variant="outline" asChild>
                  <a href={`tel:${record.phone}`}>
                    <Phone className="size-4" /> Call customer
                  </a>
                </Button>
              )}
              {record.status === 'ACTIVE' && (
                <Button variant="destructive" onClick={() => onAnchor('end')}>
                  <Flag className="size-4" /> End drive
                </Button>
              )}
              {record.status === 'READY' && (
                <Button className="col-span-2" onClick={() => onAnchor('start')}>
                  <Navigation className="size-4" /> Start drive
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Live Trip Log</CardTitle>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {events.map(({ at, title, detail, icon: Icon }) => (
            <div
              key={`${title}-${at}`}
              className="grid gap-3 px-5 py-4 sm:grid-cols-[100px_24px_180px_1fr]"
            >
              <span className="text-xs text-muted-foreground">
                {new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(
                  new Date(at),
                )}
              </span>
              <Icon className="size-4 text-blue-600" />
              <span className="font-medium">{title}</span>
              <span className="text-muted-foreground">{detail}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
