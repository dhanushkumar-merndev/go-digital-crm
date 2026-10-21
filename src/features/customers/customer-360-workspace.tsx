'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CarFront,
  Download,
  FileText,
  Pencil,
  Phone,
  Plus,
  RotateCcw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { leadDetailHref } from '@/lib/navigation/record-links';
import { toWhatsAppClickToChatUrl } from '@/lib/phone';
import { WhatsAppIcon } from '@/components/shared/whatsapp-icon';
import { LeadJourney } from '@/features/leads/lead-journey';
import { LeadBuyerCard } from '@/features/leads/lead-company-card';
import { LeadRequirementsCards } from '@/features/leads/lead-requirements-panel';
import { useMemo, useState, type ReactNode } from 'react';
import { CustomerOperationsPanel, useCustomerOperationalCases } from './customer-operational-cases';
import { CustomerDripPanel } from './customer-drip-panel';
import { CustomerAdditionalFields } from './customer-additional-fields';
import { CustomerPhoneEnquiries } from './customer-phone-enquiries';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useReturnToList } from '@/lib/navigation/use-return-to-list';
import { Customer360Skeleton } from '@/components/skeletons';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  fetchSalesCustomer360Core,
  fetchSalesCustomer360Section,
  fetchCustomerWorkspacePermissions,
  type Customer360,
  type Customer360Core,
  type Customer360LazySection,
  type Customer360LeadOption,
  type Customer360SectionPageSize,
  type Customer360SectionResult,
  type Customer360TimelineCursor,
  type CustomerWorkspacePermissions,
} from './customer-workspace-api';
import {
  CustomerDocumentUploadDialog,
  CustomerEditDialog,
  CustomerTelecmiCallDialog,
} from './customer-360-actions';

const customer360Tabs = [
  'overview',
  'leads',
  'calls',
  'followups',
  'appointments',
  'messages',
  'test-drives',
  'quotations',
  'bookings',
  'operations',
  'vehicles',
  'documents',
  'drip',
  'timeline',
] as const;

type Customer360Tab = (typeof customer360Tabs)[number];

const customerTabCreateLabel: Partial<Record<Customer360Tab, string>> = {
  overview: 'Edit customer',
  leads: 'Add lead',
  followups: 'Add follow-up',
  'test-drives': 'Schedule test drive',
  quotations: 'Create quotation',
  bookings: 'Create booking',
  documents: 'Upload document',
  drip: 'Start a drip',
  timeline: 'Add follow-up',
};

const lazySectionByTab: Partial<
  Record<Exclude<Customer360Tab, 'overview'>, Customer360LazySection>
> = {
  leads: 'leads',
  calls: 'calls',
  followups: 'followups',
  appointments: 'appointments',
  messages: 'conversations',
  'test-drives': 'test_drives',
  quotations: 'quotations',
  bookings: 'bookings',
  vehicles: 'vehicles',
  documents: 'documents',
};

function isCustomer360Tab(value: string): value is Customer360Tab {
  return customer360Tabs.includes(value as Customer360Tab);
}

function composeSalesCustomer360(
  core: Customer360Core,
  section?: Customer360SectionResult,
): Customer360 {
  const data = {
    ...core,
    vehicles: [],
    leads: [],
    calls: [],
    conversations: [],
    followups: [],
    appointments: [],
    test_drives: [],
    quotations: [],
    bookings: [],
    documents: [],
    timeline: [],
  } satisfies Customer360;
  return (section ? { ...data, [section.section]: section.records } : data) as Customer360;
}

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
  rowHref,
}: {
  headers: string[];
  rows: ReactNode[][];
  emptyLabel: string;
  /** When given, the whole row navigates. Used where a row has its own page. */
  rowHref?: (rowIndex: number) => string;
}) {
  const router = useRouter();
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
            {rows.map((row, rowIndex) => {
              const href = rowHref?.(rowIndex);
              return (
                <TableRow
                  key={rowIndex}
                  className={href ? 'cursor-pointer hover:bg-muted/50' : undefined}
                  onClick={href ? () => router.push(href) : undefined}
                >
                  {row.map((cell, cellIndex) => (
                    <TableCell key={cellIndex} className="whitespace-nowrap">
                      {/* The first cell is a real link as well as the row being
                          clickable, so the row is reachable by keyboard and can
                          be opened in a new tab. */}
                      {cellIndex === 0 && href ? (
                        <Link
                          href={href}
                          className="font-semibold text-primary hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {cell}
                        </Link>
                      ) : (
                        cell
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
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

function CustomerHeaderValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1.5 min-h-5 text-sm font-semibold">{children}</div>
    </div>
  );
}

function addressPart(address: Record<string, unknown> | undefined, key: string) {
  const value = address?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function Overview({
  data,
  role,
  onRecordChanged,
}: {
  data: Customer360;
  role: string;
  onRecordChanged?: () => void;
}) {
  const canEditRequirements = hasWorkspacePermission(useWorkspaceSession(), 'lead.update');
  const primaryAddress =
    data.addresses.find((address) => address.address_type === 'HOME') ?? data.addresses[0];
  const addressText =
    [addressPart(primaryAddress?.address, 'line1'), addressPart(primaryAddress?.address, 'line2')]
      .filter(Boolean)
      .join(', ') || '—';
  const alternatePhone = data.contacts.find(
    (contact) => contact.type === 'PHONE' && !contact.is_primary,
  )?.value;
  const opportunity = data.current_opportunity;
  const callSummary = opportunity?.latest_call_summary ?? null;
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
                ['Mobile', data.customer.primary_phone ?? '—'],
                ['Alternate mobile', alternatePhone ?? '—'],
                [
                  'WhatsApp',
                  data.customer.whatsapp_phone ??
                    (data.customer.primary_phone ? 'Same as mobile' : '—'),
                ],
                ['Email', data.customer.primary_email ?? '—'],
                ['Address', addressText],
                ['City', addressPart(primaryAddress?.address, 'city') || '—'],
                ['Pincode', addressPart(primaryAddress?.address, 'postal_code') || '—'],
                ['Customer since', formatDate(data.customer.created_at, false)],
                ['Customer UUID', data.customer.id],
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
                  [
                    'Lead ID',
                    // The opportunity has its own page; this is the shortest
                    // route to it from the customer.
                    <Link
                      key="lead-id"
                      href={leadDetailHref(role, data.current_opportunity.id)}
                      className="font-semibold text-primary hover:underline"
                    >
                      {shortId(data.current_opportunity.id)}
                    </Link>,
                  ],
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
        {opportunity && (
          <LeadBuyerCard
            leadId={opportunity.id}
            buyerType={opportunity.buyer_type}
            company={opportunity.company}
            canEdit={canEditRequirements}
            onSaved={() => onRecordChanged?.()}
          />
        )}
        {opportunity && (
          <LeadRequirementsCards
            leadId={opportunity.id}
            customerId={data.customer.id}
            interestedModel={opportunity.interested_model}
            requirements={opportunity.requirements}
            exchangeVehicle={opportunity.exchange_vehicle}
            exchangeCase={opportunity.exchange_case}
            canEdit={canEditRequirements}
            onSaved={() => onRecordChanged?.()}
          />
        )}
        <CustomerAdditionalFields customerId={data.customer.id} />
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
        {callSummary && (
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">Previous call summary</CardTitle>
              <Badge variant="violet">
                <Sparkles className="size-3" /> AI
              </Badge>
            </CardHeader>
            <CardContent>
              <p className="rounded-lg border bg-muted/20 p-3 text-sm leading-6">
                {callSummary.summary}
              </p>
              <p className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Call duration {formatDuration(callSummary.duration_seconds)}
                  {callSummary.caller_name ? ` · ${callSummary.caller_name}` : ''}
                </span>
                <span>{formatDate(callSummary.started_at)}</span>
              </p>
            </CardContent>
          </Card>
        )}
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

function leadOptionLabel(option: Customer360LeadOption) {
  return [option.source, option.interested_model, formatDate(option.created_at, false)]
    .filter(Boolean)
    .join(' · ');
}

/** "All leads" or one enquiry; scopes Calls, Follow-ups, Appointments and Messages. */
function LeadPicker({
  options,
  value,
  onChange,
  allowAll,
}: {
  options: Customer360LeadOption[];
  value: string | null;
  onChange: (leadId: string | null) => void;
  allowAll: boolean;
}) {
  if (!options.length) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Showing</span>
      <Select
        value={value ?? '__all'}
        onValueChange={(next) => onChange(next === '__all' ? null : next)}
      >
        <SelectTrigger className="h-9 w-auto min-w-64" aria-label="Lead">
          <SelectValue placeholder="Select a lead" />
        </SelectTrigger>
        <SelectContent>
          {allowAll && <SelectItem value="__all">All leads ({options.length})</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {leadOptionLabel(option)} — {option.lifecycle_status}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One row per enquiry. Opening a lead shows its own journey -- who called and
 * when, stage changes, follow-ups, visits, test drive, quotation, booking --
 * instead of a customer-wide stream of "lead received" entries.
 */
function LeadTimelines({
  options,
  role,
  defaultOpenId,
}: {
  options: Customer360LeadOption[];
  role: string;
  defaultOpenId: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId ?? options[0]?.id ?? null);
  if (!options.length) return <EmptySection label="Leads" />;
  return (
    <div className="space-y-3">
      {options.map((option) => {
        const open = option.id === openId;
        return (
          <Card key={option.id} className="overflow-hidden shadow-none">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : option.id)}
            >
              {open ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  {option.interested_model ?? 'Model not recorded'} · {option.source}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Received {formatDate(option.created_at)} · Lead {shortId(option.id)}
                </span>
              </span>
              <StatusBadge value={option.lifecycle_status} />
            </button>
            {open && (
              <div className="border-t">
                <LeadJourney leadId={option.id} />
                <div className="border-t px-5 py-3 text-right">
                  <Link
                    href={leadDetailHref(role, option.id)}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Open lead
                  </Link>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

type Customer360LazyState = {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  onRetry: () => void;
  total: number;
  page: number;
  pageSize: Customer360SectionPageSize;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSizeChange: (pageSize: Customer360SectionPageSize) => void;
};

function Customer360Content({
  data,
  role,
  activeTab: controlledActiveTab,
  onTabChange,
  onCreateForTab,
  lazyState,
  queryScope,
  onRecordChanged,
  leadOptions,
  leadFilter,
  onLeadFilterChange,
  messageLeadId,
  onMessageLeadChange,
  filterRecordsByLead,
}: {
  data: Customer360;
  role: string;
  activeTab?: Customer360Tab;
  onTabChange?: (tab: Customer360Tab) => void;
  onCreateForTab?: (tab: Customer360Tab) => void;
  lazyState?: Customer360LazyState;
  queryScope: readonly unknown[];
  /** Called after an inline edit so the owner can refetch the customer. */
  onRecordChanged?: () => void;
  leadOptions: Customer360LeadOption[];
  /** null means every lead. */
  leadFilter: string | null;
  onLeadFilterChange: (leadId: string | null) => void;
  /** Messages are read one enquiry at a time. */
  messageLeadId: string | null;
  onMessageLeadChange: (leadId: string | null) => void;
  /** The eager payload is bounded and unpaginated, so it narrows in place; the hot path filters in SQL. */
  filterRecordsByLead: boolean;
}) {
  const [localActiveTab, setLocalActiveTab] = useState<Customer360Tab>('overview');
  const activeTab = controlledActiveTab ?? localActiveTab;
  const createLabel = customerTabCreateLabel[activeTab];
  // Drip is gated on the permission rather than on `section_access`, which is
  // built by the Customer 360 RPC and would need that RPC changed to carry a
  // key the panel does not otherwise use.
  const canViewDrip = hasWorkspacePermission(useWorkspaceSession(), 'customer.drip.view');
  const operations = useCustomerOperationalCases(data.customer.id);
  const canViewOperations = Boolean(operations.data?.departments.length);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: createCustomerDocumentDownload,
    onSuccess: (result) => {
      window.location.assign(result.download_url);
      setDownloadingId(null);
    },
    onError: () => setDownloadingId(null),
  });
  const showLazyStatus = activeTab === 'overview' ? undefined : lazyState;
  const forLead = <T extends { lead_id: string | null }>(rows: T[], leadId: string | null) =>
    filterRecordsByLead && leadId ? rows.filter((row) => row.lead_id === leadId) : rows;
  const calls = forLead(data.calls, leadFilter);
  const followups = forLead(data.followups, leadFilter);
  const appointments = forLead(data.appointments, leadFilter);
  const conversations = messageLeadId ? forLead(data.conversations, messageLeadId) : [];
  const leadPicker = (
    <LeadPicker options={leadOptions} value={leadFilter} onChange={onLeadFilterChange} allowAll />
  );
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (!isCustomer360Tab(value)) return;
        setLocalActiveTab(value);
        onTabChange?.(value);
      }}
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto min-w-max justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {data.section_access.leads && <TabsTrigger value="leads">Leads</TabsTrigger>}
            {data.section_access.calls && <TabsTrigger value="calls">Calls</TabsTrigger>}
            {data.section_access.followups && (
              <TabsTrigger value="followups">Follow-ups</TabsTrigger>
            )}
            {data.section_access.appointments && (
              <TabsTrigger value="appointments">Appointments</TabsTrigger>
            )}
            {data.section_access.conversations && (
              <TabsTrigger value="messages">Messages</TabsTrigger>
            )}
            {data.section_access.test_drives && (
              <TabsTrigger value="test-drives">Test Drives</TabsTrigger>
            )}
            {data.section_access.quotations && (
              <TabsTrigger value="quotations">Quotations</TabsTrigger>
            )}
            {data.section_access.bookings && <TabsTrigger value="bookings">Bookings</TabsTrigger>}
            {canViewOperations && <TabsTrigger value="operations">Operations</TabsTrigger>}
            {data.section_access.vehicles && <TabsTrigger value="vehicles">Vehicles</TabsTrigger>}
            {data.section_access.documents && (
              <TabsTrigger value="documents">Documents</TabsTrigger>
            )}
            {canViewDrip && <TabsTrigger value="drip">Drip</TabsTrigger>}
            {data.section_access.timeline && <TabsTrigger value="timeline">Timeline</TabsTrigger>}
          </TabsList>
        </div>
        {onCreateForTab && createLabel ? (
          <Button size="sm" className="shrink-0" onClick={() => onCreateForTab(activeTab)}>
            <Plus className="size-4" /> {createLabel}
          </Button>
        ) : null}
      </div>
      {['calls', 'followups', 'appointments'].includes(activeTab) && (
        <div className="mt-4">{leadPicker}</div>
      )}
      {activeTab === 'messages' && (
        <div className="mt-4">
          <LeadPicker
            options={leadOptions}
            value={messageLeadId}
            onChange={onMessageLeadChange}
            allowAll={false}
          />
        </div>
      )}
      {showLazyStatus?.isPending ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : showLazyStatus?.isError ? (
        <Card className="mt-6 shadow-none">
          <CardContent className="flex flex-col items-center p-8 text-center">
            <TriangleAlert className="size-8 text-destructive" />
            <p className="mt-3 text-sm font-medium">This customer section could not be loaded.</p>
            <Button className="mt-4" size="sm" variant="outline" onClick={showLazyStatus.onRetry}>
              <RotateCcw className="size-4" /> Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <TabsContent value="overview">
            <Overview data={data} role={role} onRecordChanged={onRecordChanged} />
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
                rowHref={(rowIndex) => leadDetailHref(role, data.leads[rowIndex]?.id ?? '')}
                // DetailTable already wraps the first cell in the row's link, so
                // passing a Link here would nest one <a> inside another.
                rows={data.leads.map((lead) => [
                  shortId(lead.id),
                  lead.source,
                  lead.interested_model ?? '—',
                  <StatusBadge key="status" value={lead.lifecycle_status} />,
                  lead.branch_name,
                  lead.assigned_user_name ?? 'Unassigned',
                  formatDate(lead.updated_at),
                ])}
              />
              <CustomerPhoneEnquiries
                role={role}
                customerId={data.customer.id}
                customerName={data.customer.full_name}
                queryScope={queryScope}
              />
            </TabsContent>
          )}
          {data.section_access.calls && (
            <TabsContent value="calls">
              <DetailTable
                headers={[
                  'Date & time',
                  'Direction',
                  'Source',
                  'Outcome',
                  'Duration',
                  'Caller',
                  'AI summary',
                ]}
                emptyLabel="Calls"
                rows={calls.map((call) => [
                  formatDate(call.started_at),
                  call.direction === 'INBOUND' ? 'Inbound' : 'Outbound',
                  call.call_source === 'PROVIDER' ? 'IVR / provider' : 'Personal call',
                  call.outcome ? <StatusBadge key="outcome" value={call.outcome} /> : '—',
                  formatDuration(call.duration_seconds),
                  call.assigned_user_name ?? '—',
                  call.ai_summary ? (
                    <span
                      key="summary"
                      className="line-clamp-2 max-w-md whitespace-normal text-xs leading-5 text-muted-foreground"
                      title={call.ai_summary}
                    >
                      {call.ai_summary}
                    </span>
                  ) : (
                    '—'
                  ),
                ])}
              />
            </TabsContent>
          )}
          {data.section_access.followups && (
            <TabsContent value="followups">
              <DetailTable
                headers={['Due', 'Reason', 'Status', 'Owner', 'Completed']}
                emptyLabel="Follow-ups"
                rows={followups.map((followup) => [
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
                rows={appointments.map((appointment) => [
                  formatDate(appointment.scheduled_at),
                  appointment.appointment_type,
                  <StatusBadge key="status" value={appointment.status} />,
                  appointment.attendance_status ? (
                    <StatusBadge key="attendance" value={appointment.attendance_status} />
                  ) : (
                    '—'
                  ),
                  appointment.branch_name,
                  appointment.assigned_user_name ?? '—',
                ])}
              />
            </TabsContent>
          )}
          {data.section_access.conversations && (
            <TabsContent value="messages">
              <DetailTable
                headers={['Channel', 'Status', 'Messages', 'Last message', 'Owner', 'Started']}
                emptyLabel="Conversations"
                rowHref={(rowIndex) => {
                  const conversation = conversations[rowIndex];
                  return conversation?.lead_id
                    ? `${leadDetailHref(role, conversation.lead_id)}?tab=messages&conversation=${conversation.id}`
                    : leadDetailHref(role, messageLeadId ?? '');
                }}
                rows={conversations.map((conversation) => [
                  conversation.channel.replaceAll('_', ' '),
                  <StatusBadge key="status" value={conversation.status} />,
                  conversation.message_count.toLocaleString('en-IN'),
                  formatDate(conversation.latest_message_at),
                  conversation.assigned_user_name ?? '—',
                  formatDate(conversation.created_at),
                ])}
              />
            </TabsContent>
          )}
          {data.section_access.test_drives && (
            <TabsContent value="test-drives">
              <DetailTable
                headers={[
                  'Status',
                  'Branch',
                  'Owner',
                  'Started',
                  'Completed',
                  'Duration',
                  'Distance',
                ]}
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
                headers={[
                  'Registration',
                  'Vehicle',
                  'Year',
                  'Fuel',
                  'Transmission',
                  'KMs driven',
                  'Ownership',
                  'Added',
                ]}
                emptyLabel="Vehicles"
                rows={data.vehicles.map((vehicle) => [
                  vehicle.registration ?? '—',
                  [vehicle.brand, vehicle.model, vehicle.variant].filter(Boolean).join(' ') || '—',
                  vehicle.purchase_year ?? vehicle.model_year ?? '—',
                  vehicle.fuel_type ?? '—',
                  vehicle.transmission ?? '—',
                  vehicle.odometer_km == null
                    ? '—'
                    : `${vehicle.odometer_km.toLocaleString('en-IN')} km`,
                  vehicle.ownership ?? '—',
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
                    {download.isPending && downloadingId === document.id
                      ? 'Preparing…'
                      : 'Download'}
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
          {canViewOperations && (
            <TabsContent value="operations">
              <CustomerOperationsPanel query={operations} />
            </TabsContent>
          )}
          {canViewDrip && (
            <TabsContent value="drip">
              <CustomerDripPanel customerId={data.customer.id} leadId={data.leads[0]?.id ?? null} />
            </TabsContent>
          )}
          {data.section_access.timeline && (
            <TabsContent value="timeline">
              <LeadTimelines
                options={leadOptions}
                role={role}
                defaultOpenId={data.current_opportunity?.id ?? null}
              />
            </TabsContent>
          )}
          {showLazyStatus && (
            <div className="mt-4 flex flex-col justify-between gap-3 rounded-lg border bg-card p-3 text-sm sm:flex-row sm:items-center">
              <p className="text-muted-foreground">
                {showLazyStatus.total === 0
                  ? 'No records'
                  : `${((showLazyStatus.page - 1) * showLazyStatus.pageSize + 1).toLocaleString('en-IN')}–${Math.min(showLazyStatus.page * showLazyStatus.pageSize, showLazyStatus.total).toLocaleString('en-IN')} of ${showLazyStatus.total.toLocaleString('en-IN')}`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={String(showLazyStatus.pageSize)}
                  onValueChange={(value) =>
                    showLazyStatus.onPageSizeChange(Number(value) as Customer360SectionPageSize)
                  }
                  disabled={showLazyStatus.isFetching}
                >
                  <SelectTrigger className="h-9 w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[25, 50, 100].map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} rows
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={showLazyStatus.page <= 1 || showLazyStatus.isFetching}
                  onClick={showLazyStatus.onPrevious}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!showLazyStatus.hasMore || showLazyStatus.isFetching}
                  onClick={showLazyStatus.onNext}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Tabs>
  );
}

export function Customer360Workspace({ role, customerId }: { role: string; customerId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const returnToPreviousPage = useReturnToList(`/${role}/customers`);
  const [activeTab, setActiveTab] = useState<Customer360Tab>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [documentUploadOpen, setDocumentUploadOpen] = useState(false);
  const [sectionPage, setSectionPage] = useState(1);
  const [sectionPageSize, setSectionPageSize] = useState<Customer360SectionPageSize>(25);
  const [timelineCursors, setTimelineCursors] = useState<
    Record<number, Customer360TimelineCursor | null>
  >({ 1: null });
  const workspaceSession = useWorkspaceSession();
  const useSalesHotPath =
    role === 'sales-consultant' &&
    workspaceSession?.roleKey === 'sales-consultant' &&
    Boolean(workspaceSession.organizationId);
  const useWorkspaceBootstrap = Boolean(workspaceSession?.organizationId);
  const queryScope = useMemo(
    () =>
      useWorkspaceBootstrap ? workspaceQueryScope(workspaceSession) : (['legacy', role] as const),
    [role, useWorkspaceBootstrap, workspaceSession],
  );
  const bootstrapPermissions: CustomerWorkspacePermissions | undefined = useWorkspaceBootstrap
    ? {
        organizationId: workspaceSession!.organizationId as string,
        scopeKey: workspaceSession!.scopeKey,
        canView: hasWorkspacePermission(workspaceSession, 'customer.view'),
        canCreate: hasWorkspacePermission(workspaceSession, 'customer.create'),
        canLink: hasWorkspacePermission(workspaceSession, 'customer.link'),
        canUpdate: hasWorkspacePermission(workspaceSession, 'customer.update'),
        canCreateCall: hasWorkspacePermission(workspaceSession, 'call.create'),
      }
    : undefined;
  const legacyPermissions = useQuery({
    queryKey: ['customer-workspace-permissions', ...queryScope, role],
    queryFn: fetchCustomerWorkspacePermissions,
    enabled: !useWorkspaceBootstrap,
    staleTime: 60_000,
  });
  const permissions = bootstrapPermissions ?? legacyPermissions.data;
  const legacyCustomer = useQuery({
    queryKey: ['customer-360', ...queryScope, customerId, 'legacy-eager'],
    queryFn: ({ signal }) => fetchCustomer360(customerId, signal),
    enabled: !useSalesHotPath && Boolean(permissions?.canView),
  });
  const salesCore = useQuery({
    queryKey: ['customer-360', ...queryScope, customerId, 'overview'],
    queryFn: ({ signal }) => fetchSalesCustomer360Core(customerId, signal),
    enabled: useSalesHotPath && Boolean(permissions?.canView),
  });
  const [leadFilter, setLeadFilter] = useState<string | null>(null);
  const [messageLeadChoice, setMessageLeadChoice] = useState<string | null>(null);
  const leadOptions: Customer360LeadOption[] = useSalesHotPath
    ? (salesCore.data?.lead_options ?? [])
    : (legacyCustomer.data?.leads ?? []).map((lead) => ({
        id: lead.id,
        source: lead.source,
        interested_model: lead.interested_model,
        lifecycle_status: lead.lifecycle_status,
        created_at: lead.created_at,
      }));
  // Messages default to the enquiry being worked now.
  const messageLeadId =
    messageLeadChoice ??
    (useSalesHotPath
      ? salesCore.data?.current_opportunity?.id
      : legacyCustomer.data?.current_opportunity?.id) ??
    leadOptions[0]?.id ??
    null;
  // Drip is deliberately absent from the map: it fetches its own panel, so it
  // must not drive the shared section pager or its loading and error states.
  const lazySection = activeTab === 'overview' ? null : (lazySectionByTab[activeTab] ?? null);
  const activeCursor = lazySection === 'timeline' ? (timelineCursors[sectionPage] ?? null) : null;
  const sectionLeadId =
    lazySection === 'conversations'
      ? messageLeadId
      : lazySection && ['calls', 'followups', 'appointments'].includes(lazySection)
        ? leadFilter
        : null;
  const sectionFilters = {
    pageSize: sectionPageSize,
    cursorAt: activeCursor?.occurred_at ?? null,
    cursorId: activeCursor?.id ?? null,
    leadId: sectionLeadId,
  };
  const salesSection = useQuery({
    queryKey: [
      'customer-360',
      ...queryScope,
      customerId,
      lazySection ?? 'overview',
      sectionPage,
      sectionFilters,
    ],
    queryFn: ({ signal }) => {
      if (!lazySection) throw new Error('CUSTOMER_360_SECTION_REQUIRED');
      return fetchSalesCustomer360Section(
        {
          customerId,
          section: lazySection,
          page: sectionPage,
          pageSize: sectionPageSize,
          cursor: activeCursor,
          leadId: sectionLeadId,
        },
        signal,
      );
    },
    enabled:
      useSalesHotPath &&
      Boolean(lazySection) &&
      Boolean(salesCore.data && lazySection && salesCore.data.section_access[lazySection]) &&
      (lazySection !== 'conversations' || Boolean(messageLeadId)),
  });

  const customerIsPending = useSalesHotPath ? salesCore.isPending : legacyCustomer.isPending;
  const customerIsError = useSalesHotPath ? salesCore.isError : legacyCustomer.isError;

  if (
    (!useWorkspaceBootstrap && legacyPermissions.isPending) ||
    (customerIsPending && permissions?.canView)
  )
    return <Customer360Skeleton />;
  if (
    (!useWorkspaceBootstrap && legacyPermissions.isError) ||
    customerIsError ||
    !permissions?.canView
  )
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
            <Button variant="outline" onClick={returnToPreviousPage}>
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!useWorkspaceBootstrap) void legacyPermissions.refetch();
                if (useSalesHotPath) void salesCore.refetch();
                else void legacyCustomer.refetch();
              }}
            >
              <RotateCcw className="size-4" /> Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  if (useSalesHotPath && !salesCore.data) return null;
  if (!useSalesHotPath && !legacyCustomer.data) return null;
  const data = useSalesHotPath
    ? composeSalesCustomer360(salesCore.data as Customer360Core, salesSection.data)
    : (legacyCustomer.data as Customer360);
  const lazyState: Customer360LazyState | undefined =
    useSalesHotPath && lazySection
      ? {
          isPending: salesSection.isPending,
          isError: salesSection.isError,
          isFetching: salesSection.isFetching,
          onRetry: () => void salesSection.refetch(),
          total: salesSection.data?.total ?? 0,
          page: sectionPage,
          pageSize: sectionPageSize,
          hasMore:
            Boolean(salesSection.data?.has_more) &&
            (lazySection !== 'timeline' || Boolean(salesSection.data?.next_cursor)),
          onPrevious: () => setSectionPage((page) => Math.max(1, page - 1)),
          onNext: () => {
            if (lazySection === 'timeline' && salesSection.data?.next_cursor) {
              setTimelineCursors((cursors) => ({
                ...cursors,
                [sectionPage + 1]: salesSection.data?.next_cursor ?? null,
              }));
            }
            setSectionPage((page) => page + 1);
          },
          onPageSizeChange: (pageSize) => {
            setSectionPageSize(pageSize);
            setSectionPage(1);
            setTimelineCursors({ 1: null });
          },
        }
      : undefined;

  const whatsappNumber = data.customer.whatsapp_phone ?? data.customer.primary_phone;
  const refetchCustomer = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer-360', ...queryScope, customerId] });
    if (useSalesHotPath) void salesCore.refetch();
    else void legacyCustomer.refetch();
  };

  function selectCustomerTab(tab: Customer360Tab) {
    setActiveTab(tab);
    setSectionPage(1);
    setTimelineCursors({ 1: null });
  }

  function createCustomerTabData(tab: Customer360Tab) {
    switch (tab) {
      case 'overview':
      case 'vehicles':
        setEditOpen(true);
        return;
      case 'documents':
        setDocumentUploadOpen(true);
        return;
      case 'leads':
        router.push(`/${role}/my-leads?action=create`);
        return;
      case 'timeline':
      case 'followups':
        router.push(`/${role}/follow-ups?action=create`);
        return;
      case 'test-drives':
        router.push(`/${role}/test-drives?action=create`);
        return;
      case 'quotations':
        router.push(`/${role}/quotations?action=create`);
        return;
      case 'bookings':
        router.push(`/${role}/bookings?action=create`);
    }
  }

  return (
    <div className="mx-auto w-full space-y-5">
      <div>
        <Button variant="ghost" size="sm" className="-ml-3 mb-3" onClick={returnToPreviousPage}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Card className="overflow-hidden shadow-none">
          <CardContent className="p-0">
            <div className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-[1.45fr_repeat(4,minmax(0,1fr))]">
              <div className="min-w-0 xl:border-r xl:pr-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-bold tracking-tight text-heading">
                    {data.customer.full_name}
                  </h1>
                  {data.current_opportunity?.work_state && (
                    <StatusBadge value={data.current_opportunity.work_state} />
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {data.customer.primary_phone && (
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <Phone className="size-4 text-emerald-600" /> {data.customer.primary_phone}
                    </span>
                  )}
                  {data.customer.primary_email && <span>{data.customer.primary_email}</span>}
                </div>
              </div>
              <CustomerHeaderValue label="Interested model">
                {data.current_opportunity?.interested_model ?? 'Not recorded'}
              </CustomerHeaderValue>
              <CustomerHeaderValue label="Lead stage">
                {data.current_opportunity?.lifecycle_status ? (
                  <StatusBadge value={data.current_opportunity.lifecycle_status} />
                ) : (
                  'No visible lead'
                )}
              </CustomerHeaderValue>
              <CustomerHeaderValue label="Temperature">
                {data.current_opportunity?.temperature ? (
                  <StatusBadge value={data.current_opportunity.temperature} />
                ) : (
                  'Not recorded'
                )}
              </CustomerHeaderValue>
              <CustomerHeaderValue label="Sales owner">
                {data.current_opportunity?.assigned_user_name ?? 'Unassigned'}
                {data.current_opportunity?.assigned_user_phone && (
                  <a
                    href={`tel:${data.current_opportunity.assigned_user_phone}`}
                    className="mt-1 flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <Phone className="size-3" /> {data.current_opportunity.assigned_user_phone}
                  </a>
                )}
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {data.current_opportunity?.branch_name ?? 'No branch visible'}
                </span>
              </CustomerHeaderValue>
            </div>
            <div className="flex flex-wrap gap-2 border-t p-3">
              {data.customer.primary_phone && permissions.canCreateCall ? (
                <Button size="sm" variant="outline" onClick={() => setCallOpen(true)}>
                  <Phone className="size-3.5 text-emerald-600" /> Call through CRM
                </Button>
              ) : null}
              {whatsappNumber ? (
                <Button size="sm" variant="outline" asChild>
                  <a
                    href={toWhatsAppClickToChatUrl(whatsappNumber)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <WhatsAppIcon className="size-3.5" /> WhatsApp
                  </a>
                </Button>
              ) : null}
              {permissions.canUpdate ? (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-3.5 text-blue-600" /> Edit customer
                </Button>
              ) : null}
              {data.section_access.test_drives ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => selectCustomerTab('test-drives')}
                >
                  <CarFront className="size-3.5 text-blue-600" /> Test drive
                </Button>
              ) : null}
              {data.section_access.quotations ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => selectCustomerTab('quotations')}
                >
                  <FileText className="size-3.5 text-violet-600" /> Quotation
                </Button>
              ) : null}
              {data.section_access.bookings ? (
                <Button
                  type="button"
                  size="sm"
                  className="ml-auto"
                  onClick={() => selectCustomerTab('bookings')}
                >
                  Open bookings
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
      <Customer360Content
        data={data}
        role={role}
        activeTab={activeTab}
        onTabChange={selectCustomerTab}
        onCreateForTab={createCustomerTabData}
        lazyState={lazyState}
        queryScope={queryScope}
        onRecordChanged={refetchCustomer}
        leadOptions={leadOptions}
        leadFilter={leadFilter}
        onLeadFilterChange={(leadId) => {
          setLeadFilter(leadId);
          setSectionPage(1);
        }}
        messageLeadId={messageLeadId}
        onMessageLeadChange={(leadId) => {
          setMessageLeadChoice(leadId);
          setSectionPage(1);
        }}
        filterRecordsByLead={!useSalesHotPath}
      />
      {permissions.canUpdate && editOpen ? (
        <CustomerEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          customerId={data.customer.id}
          onSaved={refetchCustomer}
        />
      ) : null}
      {permissions.canCreateCall && callOpen ? (
        <CustomerTelecmiCallDialog
          open={callOpen}
          onOpenChange={setCallOpen}
          customerId={data.customer.id}
          organizationId={permissions.organizationId}
          customerName={data.customer.full_name}
          customerPhone={data.customer.primary_phone}
          onStarted={() => {
            selectCustomerTab('timeline');
            void queryClient.invalidateQueries({
              queryKey: ['customer-360', ...queryScope, customerId],
            });
          }}
        />
      ) : null}
      {documentUploadOpen ? (
        <CustomerDocumentUploadDialog
          open={documentUploadOpen}
          onOpenChange={setDocumentUploadOpen}
          organizationId={permissions.organizationId}
          customerId={data.customer.id}
          onUploaded={() => {
            if (useSalesHotPath) void salesSection.refetch();
            else void legacyCustomer.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
