'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  CarFront,
  Download,
  FileText,
  MessageSquareText,
  Phone,
  RotateCcw,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  createCustomerDocumentDownload,
  fetchCustomer360,
  fetchCustomerWorkspacePermissions,
  type Customer360,
} from './customer-workspace-api';

function formatDate(value: string | null | undefined, includeTime = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(
    'en-IN',
    includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  ).format(new Date(value));
}

function formatCurrency(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(value: string) {
  return value.slice(0, 8).toUpperCase();
}

function EmptySection({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">No {label.toLowerCase()} in this customer context</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Only records permitted by your current data scope are shown.
      </p>
    </div>
  );
}

function DetailTable({
  headers,
  rows,
  emptyLabel,
}: {
  headers: string[];
  rows: ReactNode[][];
  emptyLabel: string;
}) {
  if (!rows.length) return <EmptySection label={emptyLabel} />;
  return (
    <Card className="overflow-hidden shadow-none">
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header} className="whitespace-nowrap">
                  {header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex} className="whitespace-nowrap">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function InformationGrid({ values }: { values: Array<[string, ReactNode]> }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {values.map(([label, value]) => (
        <div key={label}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <div className="mt-1.5 text-sm font-semibold">{value || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function Overview({ data }: { data: Customer360 }) {
  const primaryAddress =
    data.addresses.find((address) => address.address_type === 'HOME') ?? data.addresses[0];
  const addressText = primaryAddress
    ? Object.values(primaryAddress.address)
        .filter((value): value is string | number => ['string', 'number'].includes(typeof value))
        .join(', ')
    : '—';
  return (
    <div className="grid gap-6 xl:grid-cols-[1.4fr_.8fr]">
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Customer information</CardTitle>
          </CardHeader>
          <CardContent>
            <InformationGrid
              values={[
                ['Customer UUID', data.customer.id],
                ['Primary phone', data.customer.primary_phone ?? '—'],
                ['Primary email', data.customer.primary_email ?? '—'],
                ['Customer since', formatDate(data.customer.created_at, false)],
                ['Address', addressText],
                ['Known contacts', data.contacts.length.toLocaleString()],
              ]}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CarFront className="size-4 text-blue-600" /> Current opportunity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.current_opportunity ? (
              <InformationGrid
                values={[
                  ['Lead ID', shortId(data.current_opportunity.id)],
                  ['Interested model', data.current_opportunity.interested_model ?? '—'],
                  [
                    'Lifecycle',
                    <StatusBadge
                      key="lifecycle"
                      value={data.current_opportunity.lifecycle_status}
                    />,
                  ],
                  [
                    'Temperature',
                    data.current_opportunity.temperature ? (
                      <StatusBadge key="temperature" value={data.current_opportunity.temperature} />
                    ) : (
                      '—'
                    ),
                  ],
                  ['Branch', data.current_opportunity.branch_name],
                  ['Sales owner', data.current_opportunity.assigned_user_name ?? 'Unassigned'],
                  ['Source', data.current_opportunity.source],
                  ['Campaign', data.current_opportunity.campaign ?? '—'],
                  ['Last activity', formatDate(data.current_opportunity.updated_at)],
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No lead opportunity is visible with your current permissions and scope.
              </p>
            )}
          </CardContent>
        </Card>
        {data.custom_fields.length > 0 && (
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Custom information</CardTitle>
            </CardHeader>
            <CardContent>
              <InformationGrid
                values={data.custom_fields.map((field) => [
                  field.label,
                  typeof field.value === 'object'
                    ? JSON.stringify(field.value)
                    : String(field.value ?? '—'),
                ])}
              />
            </CardContent>
          </Card>
        )}
      </div>
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Contact identifiers</CardTitle>
            <CardDescription>
              Identifiers may repeat across different customer UUIDs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.contacts.length ? (
              data.contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <p className="text-xs text-muted-foreground">{contact.type}</p>
                    <p className="text-sm font-semibold">{contact.value}</p>
                  </div>
                  {contact.is_primary && <Badge variant="info">Primary</Badge>}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No additional contacts.</p>
            )}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Recent notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.notes.length ? (
              data.notes.slice(0, 8).map((note) => (
                <div key={note.id} className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-sm leading-6">{note.body}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {note.created_by_name ?? 'CRM user'} · {formatDate(note.created_at)}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No customer notes yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Timeline({ data }: { data: Customer360 }) {
  if (!data.timeline.length) return <EmptySection label="Timeline activity" />;
  const iconByType = (type: string) => {
    if (type.includes('CALL')) return Phone;
    if (type.includes('MESSAGE')) return MessageSquareText;
    if (type.includes('FOLLOW')) return CalendarClock;
    return UserRound;
  };
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Customer activity timeline</CardTitle>
        <CardDescription>Permission-filtered events across this customer journey.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.timeline.map((item, index) => {
          const Icon = iconByType(item.activity_type);
          return (
            <div className="relative flex gap-3 pb-6" key={item.id}>
              {index < data.timeline.length - 1 && (
                <span className="absolute left-4 top-8 h-full w-px bg-border" />
              )}
              <div className="z-10 grid size-8 shrink-0 place-items-center rounded-full border bg-background text-blue-600">
                <Icon className="size-4" />
              </div>
              <div className="pt-0.5">
                <p className="text-sm font-semibold">{item.activity_type.replaceAll('_', ' ')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.actor_name ?? 'System'} · {formatDate(item.occurred_at)}
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function Customer360Content({ data }: { data: Customer360 }) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: createCustomerDocumentDownload,
    onSuccess: (result) => {
      window.location.assign(result.download_url);
      setDownloadingId(null);
    },
    onError: () => setDownloadingId(null),
  });
  return (
    <Tabs defaultValue="overview">
      <div className="overflow-x-auto pb-1">
        <TabsList className="h-auto min-w-max justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {data.section_access.leads && <TabsTrigger value="leads">Leads</TabsTrigger>}
          {data.section_access.calls && <TabsTrigger value="calls">Calls</TabsTrigger>}
          {data.section_access.conversations && (
            <TabsTrigger value="conversations">Conversations</TabsTrigger>
          )}
          {data.section_access.followups && <TabsTrigger value="followups">Follow-ups</TabsTrigger>}
          {data.section_access.appointments && (
            <TabsTrigger value="appointments">Appointments</TabsTrigger>
          )}
          {data.section_access.test_drives && (
            <TabsTrigger value="test-drives">Test Drives</TabsTrigger>
          )}
          {data.section_access.quotations && (
            <TabsTrigger value="quotations">Quotations</TabsTrigger>
          )}
          {data.section_access.bookings && <TabsTrigger value="bookings">Bookings</TabsTrigger>}
          {data.section_access.vehicles && <TabsTrigger value="vehicles">Vehicles</TabsTrigger>}
          {data.section_access.documents && <TabsTrigger value="documents">Documents</TabsTrigger>}
          {data.section_access.timeline && <TabsTrigger value="timeline">Timeline</TabsTrigger>}
        </TabsList>
      </div>
      <TabsContent value="overview">
        <Overview data={data} />
      </TabsContent>
      {data.section_access.leads && (
        <TabsContent value="leads">
          <DetailTable
            headers={[
              'Lead ID',
              'Source',
              'Model',
              'Lifecycle',
              'Branch',
              'Owner',
              'Last activity',
            ]}
            emptyLabel="Leads"
            rows={data.leads.map((lead) => [
              <span key="id" className="font-semibold">
                {shortId(lead.id)}
              </span>,
              lead.source,
              lead.interested_model ?? '—',
              <StatusBadge key="status" value={lead.lifecycle_status} />,
              lead.branch_name,
              lead.assigned_user_name ?? 'Unassigned',
              formatDate(lead.updated_at),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.calls && (
        <TabsContent value="calls">
          <DetailTable
            headers={[
              'Started',
              'Direction',
              'Duration',
              'Outcome',
              'Agent',
              'Recording',
              'Transcript',
            ]}
            emptyLabel="Calls"
            rows={data.calls.map((call) => [
              formatDate(call.started_at),
              <StatusBadge key="direction" value={call.direction} />,
              formatDuration(call.duration_seconds),
              call.outcome ?? '—',
              call.assigned_user_name ?? '—',
              call.recording_status ?? '—',
              call.transcript_status ?? '—',
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.conversations && (
        <TabsContent value="conversations">
          <DetailTable
            headers={['Channel', 'Status', 'Owner', 'Messages', 'Latest message', 'Started']}
            emptyLabel="Conversations"
            rows={data.conversations.map((conversation) => [
              conversation.channel.replaceAll('_', ' '),
              <StatusBadge key="status" value={conversation.status} />,
              conversation.assigned_user_name ?? 'Unassigned',
              conversation.message_count.toLocaleString(),
              formatDate(conversation.latest_message_at),
              formatDate(conversation.created_at),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.followups && (
        <TabsContent value="followups">
          <DetailTable
            headers={['Due', 'Reason', 'Status', 'Owner', 'Completed']}
            emptyLabel="Follow-ups"
            rows={data.followups.map((followup) => [
              formatDate(followup.due_at),
              followup.reason,
              <StatusBadge key="status" value={followup.status} />,
              followup.assigned_user_name ?? '—',
              formatDate(followup.completed_at),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.appointments && (
        <TabsContent value="appointments">
          <DetailTable
            headers={['Scheduled', 'Type', 'Status', 'Attendance', 'Branch', 'Owner']}
            emptyLabel="Appointments"
            rows={data.appointments.map((appointment) => [
              formatDate(appointment.scheduled_at),
              appointment.appointment_type,
              <StatusBadge key="status" value={appointment.status} />,
              appointment.attendance_status ?? '—',
              appointment.branch_name,
              appointment.assigned_user_name ?? '—',
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.test_drives && (
        <TabsContent value="test-drives">
          <DetailTable
            headers={['Status', 'Branch', 'Owner', 'Started', 'Completed', 'Duration', 'Distance']}
            emptyLabel="Test drives"
            rows={data.test_drives.map((drive) => [
              <StatusBadge key="status" value={drive.status} />,
              drive.branch_name,
              drive.assigned_user_name ?? '—',
              formatDate(drive.started_at),
              formatDate(drive.completed_at),
              formatDuration(drive.duration_seconds),
              drive.distance_meters == null
                ? '—'
                : `${(drive.distance_meters / 1000).toFixed(1)} km`,
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.quotations && (
        <TabsContent value="quotations">
          <DetailTable
            headers={['Quotation', 'Status', 'Version', 'Amount', 'Approval', 'Updated']}
            emptyLabel="Quotations"
            rows={data.quotations.map((quotation) => [
              <span key="number" className="font-semibold">
                {quotation.quotation_number}
              </span>,
              <StatusBadge key="status" value={quotation.status} />,
              quotation.current_version,
              formatCurrency(quotation.total_amount),
              quotation.approval_status ?? '—',
              formatDate(quotation.updated_at),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.bookings && (
        <TabsContent value="bookings">
          <DetailTable
            headers={[
              'Booking',
              'Status',
              'Booking amount',
              'Total value',
              'Finance',
              'Exchange',
              'Expected delivery',
            ]}
            emptyLabel="Bookings"
            rows={data.bookings.map((booking) => [
              <span key="number" className="font-semibold">
                {booking.booking_number}
              </span>,
              <StatusBadge key="status" value={booking.status} />,
              formatCurrency(booking.booking_amount),
              formatCurrency(booking.total_value),
              booking.finance_required ? 'Required' : 'No',
              booking.exchange_required ? 'Required' : 'No',
              formatDate(booking.expected_delivery_date, false),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.vehicles && (
        <TabsContent value="vehicles">
          <DetailTable
            headers={['Registration', 'Brand', 'Model', 'Variant', 'Year', 'Added']}
            emptyLabel="Vehicles"
            rows={data.vehicles.map((vehicle) => [
              vehicle.registration ?? '—',
              vehicle.brand ?? '—',
              vehicle.model ?? '—',
              vehicle.variant ?? '—',
              vehicle.model_year ?? '—',
              formatDate(vehicle.created_at, false),
            ])}
          />
        </TabsContent>
      )}
      {data.section_access.documents && (
        <TabsContent value="documents">
          <DetailTable
            headers={['File', 'Type', 'Size', 'Uploaded', 'Action']}
            emptyLabel="Documents"
            rows={data.documents.map((document) => [
              <span key="file" className="font-semibold">
                {document.file_name ?? 'Private document'}
              </span>,
              document.mime_type,
              formatBytes(document.size_bytes),
              formatDate(document.created_at),
              <Button
                key="download"
                size="sm"
                variant="outline"
                disabled={download.isPending && downloadingId === document.id}
                onClick={() => {
                  setDownloadingId(document.id);
                  download.mutate(document.id);
                }}
              >
                <Download className="size-3.5" />
                {download.isPending && downloadingId === document.id ? 'Preparing…' : 'Download'}
              </Button>,
            ])}
          />
          {download.isError && (
            <p className="mt-3 text-sm text-destructive">
              A short-lived download could not be created. Verify document access and try again.
            </p>
          )}
        </TabsContent>
      )}
      {data.section_access.timeline && (
        <TabsContent value="timeline">
          <Timeline data={data} />
        </TabsContent>
      )}
    </Tabs>
  );
}

export function Customer360Workspace({ role, customerId }: { role: string; customerId: string }) {
  const permissions = useQuery({
    queryKey: ['customer-workspace-permissions'],
    queryFn: fetchCustomerWorkspacePermissions,
    staleTime: 60_000,
  });
  const customer = useQuery({
    queryKey: [
      'customer-360',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      customerId,
    ],
    queryFn: () => fetchCustomer360(customerId),
    enabled: Boolean(permissions.data?.canView),
  });

  if (permissions.isPending || (customer.isPending && permissions.data?.canView))
    return (
      <div className="mx-auto max-w-[1800px] space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
        <div className="grid gap-6 xl:grid-cols-[1.4fr_.8fr]">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  if (permissions.isError || customer.isError)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Customer 360 is not available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The customer was not found in your authorized tenant/branch/team/record context, or the
            required customer workspace migration is not active. Reference: GDM-CUSTOMER-360.
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/${role}/customers`}>
                <ArrowLeft className="size-4" /> Customers
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void permissions.refetch();
                void customer.refetch();
              }}
            >
              <RotateCcw className="size-4" /> Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  if (!customer.data) return null;
  const data = customer.data;

  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-3">
          <Link href={`/${role}/customers`}>
            <ArrowLeft className="size-4" /> Authorized customers
          </Link>
        </Button>
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{data.customer.full_name}</h1>
              {data.current_opportunity?.lifecycle_status && (
                <StatusBadge value={data.current_opportunity.lifecycle_status} />
              )}
              {data.current_opportunity?.work_state && (
                <StatusBadge value={data.current_opportunity.work_state} />
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Customer {shortId(data.customer.id)} · Immutable UUID {data.customer.id}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.customer.primary_phone && (
              <Button variant="outline" asChild>
                <a href={`tel:${data.customer.primary_phone}`}>
                  <Phone className="size-4" /> Call
                </a>
              </Button>
            )}
            {data.current_opportunity?.id && (
              <Button asChild>
                <Link href={`/${role}/record/${data.current_opportunity.id}`}>
                  <FileText className="size-4" /> Open lead
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>
      <Customer360Content data={data} />
    </div>
  );
}
