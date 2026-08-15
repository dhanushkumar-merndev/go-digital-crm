'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileAudio,
  Info,
  PhoneCall,
  Plus,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  createCallRecordingDownload,
  fetchCallDetail,
  fetchCallPartyOptions,
  fetchCallScopeOptions,
  fetchCallWorkspace,
  fetchCallWorkspacePermissions,
  finalizeManualCall,
  logCompletedManualCall,
  type CallPartyOption,
  type CallRecord,
  type CallWorkspaceResult,
  type FinalizeManualCallInput,
} from './call-workspace-api';
import {
  isCallVersionConflict,
  parseCallQuery,
  toCallQueryString,
  type CallOutcomeFilter,
  type CallQuery,
  type CallSourceFilter,
  type CallStatusFilter,
} from './call-workspace-query';

const outcomeOptions: Array<{
  value: FinalizeManualCallInput['outcome'];
  label: string;
}> = [
  { value: 'CONNECTED', label: 'Connected' },
  { value: 'NO_ANSWER', label: 'No answer' },
  { value: 'BUSY', label: 'Busy' },
  { value: 'SWITCHED_OFF', label: 'Switched off' },
  { value: 'CALLBACK_REQUIRED', label: 'Callback required' },
  { value: 'WRONG_NUMBER', label: 'Wrong number' },
  { value: 'OTHER', label: 'Other' },
];

const chartSeries: [string, string] = ['Total calls', 'Connected calls'];

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function dateTimeLocal(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function callMetrics(kpis: CallWorkspaceResult['kpis']): Metric[] {
  return [
    { label: 'Calls today', value: kpis.total_today.toLocaleString('en-IN') },
    { label: 'Connected', value: kpis.connected_today.toLocaleString('en-IN') },
    { label: 'Connection rate', value: `${kpis.connection_rate.toFixed(1)}%` },
    {
      label: 'Average duration',
      value: formatDuration(kpis.average_duration_seconds),
      helper: 'Today, completed calls',
    },
    {
      label: 'Callbacks required',
      value: kpis.callbacks_required.toLocaleString('en-IN'),
      helper: 'Current authorized scope',
    },
    {
      label: 'Recordings ready',
      value: kpis.recordings_ready.toLocaleString('en-IN'),
      helper: 'Private Tigris copies today',
    },
  ];
}

function ManualCallDialog({
  organizationId,
  open,
  initialStartedAt,
  initialEndedAt,
  onOpenChange,
  onCreated,
}: {
  organizationId: string;
  open: boolean;
  initialStartedAt: string;
  initialEndedAt: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [partySearch, setPartySearch] = useState('');
  const [partyKey, setPartyKey] = useState('');
  const [branchId, setBranchId] = useState('');
  const [teamId, setTeamId] = useState('none');
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('OUTBOUND');
  const [outcome, setOutcome] = useState<FinalizeManualCallInput['outcome']>('CONNECTED');
  const debouncedPartySearch = useDebouncedValue(partySearch, 300);
  const requestIds = useRef<{ create: string; finalize: string } | null>(null);
  const scopeOptions = useQuery({
    queryKey: ['call-scope-options', organizationId],
    queryFn: fetchCallScopeOptions,
    enabled: open,
  });
  const parties = useQuery({
    queryKey: ['call-party-options', organizationId, debouncedPartySearch],
    queryFn: ({ signal }) => fetchCallPartyOptions(debouncedPartySearch, signal),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const selectedParty = parties.data?.find((party) => party.key === partyKey) ?? null;
  const selectedBranchId = selectedParty?.branch_id ?? branchId ?? '';
  const selectedTeamId = selectedParty?.lead_id ? (selectedParty.team_id ?? 'none') : teamId;
  const availableTeams =
    scopeOptions.data?.teams.filter((team) => team.branch_id === selectedBranchId) ?? [];
  const mutation = useMutation({
    mutationFn: logCompletedManualCall,
    onSuccess: () => {
      requestIds.current = null;
      onCreated();
      onOpenChange(false);
    },
  });

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      mutation.reset();
      requestIds.current = null;
      setPartySearch('');
      setPartyKey('');
      setBranchId('');
      setTeamId('none');
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Log completed call</DialogTitle>
          <DialogDescription>
            Record a personal or external phone call. This does not claim the call was placed by a
            connected IVR provider.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedParty || !selectedBranchId) return;
            const form = new FormData(event.currentTarget);
            requestIds.current ??= {
              create: globalThis.crypto.randomUUID(),
              finalize: globalThis.crypto.randomUUID(),
            };
            mutation.mutate({
              organizationId,
              branchId: selectedBranchId,
              teamId: selectedTeamId === 'none' ? null : selectedTeamId,
              leadId: selectedParty.lead_id,
              customerId: selectedParty.customer_id,
              direction,
              startedAt: new Date(String(form.get('startedAt'))).toISOString(),
              endedAt: new Date(String(form.get('endedAt'))).toISOString(),
              outcome,
              notes: String(form.get('notes') ?? ''),
              createRequestId: requestIds.current.create,
              finalizeRequestId: requestIds.current.finalize,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Find customer or lead
            <Input
              value={partySearch}
              onChange={(event) => setPartySearch(event.target.value)}
              maxLength={160}
              placeholder="Search customer name, phone or UUID…"
            />
          </label>
          <div className="grid gap-1.5 text-sm font-medium">
            Call party
            <Select
              value={partyKey}
              onValueChange={(value) => {
                setPartyKey(value);
                const party = parties.data?.find((option) => option.key === value);
                if (party?.branch_id) setBranchId(party.branch_id);
                if (party?.lead_id) setTeamId(party.team_id ?? 'none');
              }}
              disabled={parties.isPending || !parties.data?.length}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={parties.isPending ? 'Loading authorized parties…' : 'Select party'}
                />
              </SelectTrigger>
              <SelectContent>
                {parties.data?.map((party: CallPartyOption) => (
                  <SelectItem key={party.key} value={party.key}>
                    {party.customer_name} · {party.phone ?? 'No phone'} · {party.context_label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {parties.isError && (
              <p className="text-xs text-destructive">Authorized call parties could not load.</p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 text-sm font-medium">
              Branch
              <Select
                value={selectedBranchId}
                onValueChange={(value) => {
                  setBranchId(value);
                  setTeamId('none');
                }}
                disabled={Boolean(selectedParty?.lead_id)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {scopeOptions.data?.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 text-sm font-medium">
              Team <span className="font-normal text-muted-foreground">(optional)</span>
              <Select
                value={selectedTeamId}
                onValueChange={setTeamId}
                disabled={Boolean(selectedParty?.lead_id) || !selectedBranchId}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No team</SelectItem>
                  {availableTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 text-sm font-medium">
              Direction
              <Select
                value={direction}
                onValueChange={(value) => setDirection(value as 'INBOUND' | 'OUTBOUND')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OUTBOUND">Outbound</SelectItem>
                  <SelectItem value="INBOUND">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 text-sm font-medium">
              Outcome
              <Select
                value={outcome}
                onValueChange={(value) => setOutcome(value as FinalizeManualCallInput['outcome'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {outcomeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Started at
              <Input
                name="startedAt"
                type="datetime-local"
                required
                defaultValue={initialStartedAt}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Ended at
              <Input name="endedAt" type="datetime-local" required defaultValue={initialEndedAt} />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Notes <span className="font-normal text-muted-foreground">(optional)</span>
            <Textarea name="notes" maxLength={4000} rows={4} />
          </label>
          {mutation.isError && (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <div>
                <AlertTitle>Call could not be finalized</AlertTitle>
                <AlertDescription>
                  Check the party, branch and times. If the initial log was saved, it appears as a
                  pending call and can be finalized from its detail panel.
                </AlertDescription>
              </div>
            </Alert>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!selectedParty || !selectedBranchId || mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : 'Log call'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

function CallDetailSheet({
  callId,
  initialEndedAt,
  role,
  canUpdate,
  canDownload,
  onOpenChange,
  onUpdated,
}: {
  callId: string | null;
  initialEndedAt: string;
  role: string;
  canUpdate: boolean;
  canDownload: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const detail = useQuery({
    queryKey: ['call-detail', callId],
    queryFn: () => fetchCallDetail(callId as string),
    enabled: Boolean(callId),
  });
  const [outcome, setOutcome] = useState<FinalizeManualCallInput['outcome']>('CONNECTED');
  const finalizationRequestId = useRef<string | null>(null);
  const finalize = useMutation({
    mutationFn: finalizeManualCall,
    onSuccess: () => {
      finalizationRequestId.current = null;
      onUpdated();
      void detail.refetch();
    },
  });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: createCallRecordingDownload,
    onSuccess: (result) => {
      setDownloadingId(null);
      window.location.assign(result.download_url);
    },
    onError: () => setDownloadingId(null),
  });
  const data = detail.data;

  return (
    <Sheet
      open={Boolean(callId)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          finalizationRequestId.current = null;
          finalize.reset();
        }
        onOpenChange(nextOpen);
      }}
    >
      <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto p-6 sm:w-[620px]">
        <SheetTitle>Call detail</SheetTitle>
        <SheetDescription className="mt-1">
          Scoped call metadata, private recording access and reviewed AI output.
        </SheetDescription>
        {detail.isPending && (
          <div className="mt-8 text-sm text-muted-foreground">Loading call…</div>
        )}
        {detail.isError && (
          <Alert variant="destructive" className="mt-6">
            <TriangleAlert className="size-4" />
            <div>
              <AlertTitle>Call detail unavailable</AlertTitle>
              <AlertDescription>
                The record may be outside your current permission or data scope.
              </AlertDescription>
            </div>
          </Alert>
        )}
        {data && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
              <div>
                <p className="text-lg font-semibold">{data.customer_name ?? 'Restricted party'}</p>
                <p className="mt-1 text-sm text-muted-foreground">{data.phone ?? 'Phone hidden'}</p>
              </div>
              <div className="flex gap-2">
                <StatusBadge value={data.status} />
                {data.outcome && <StatusBadge value={data.outcome} />}
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <DetailValue label="Called at">{formatDate(data.started_at)}</DetailValue>
              <DetailValue label="Duration">{formatDuration(data.duration_seconds)}</DetailValue>
              <DetailValue label="Direction">
                <StatusBadge value={data.direction} />
              </DetailValue>
              <DetailValue label="Source">
                <StatusBadge value={data.call_source} />
              </DetailValue>
              <DetailValue label="Caller">{data.caller_name}</DetailValue>
              <DetailValue label="Scope">
                {data.branch_name}
                {data.team_name ? ` · ${data.team_name}` : ''}
              </DetailValue>
            </div>
            {(data.customer_id || data.lead_id) && (
              <div className="flex flex-wrap gap-2">
                {data.customer_id && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/${role}/customers/${data.customer_id}`}>
                      <ExternalLink className="size-3.5" /> Customer 360
                    </Link>
                  </Button>
                )}
                {data.lead_id && (
                  <Badge variant="outline">Lead {data.lead_id.slice(0, 8).toUpperCase()}</Badge>
                )}
              </div>
            )}
            {data.notes && (
              <Card className="shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Call notes</CardTitle>
                </CardHeader>
                <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {data.notes}
                </CardContent>
              </Card>
            )}
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Recordings</CardTitle>
                <CardDescription>
                  Playback/download URLs are created on demand and expire after five minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.recordings.length ? (
                  data.recordings.map((recording) => (
                    <div
                      key={recording.id}
                      className="flex flex-col justify-between gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
                    >
                      <div className="flex items-center gap-3">
                        <div className="grid size-9 place-items-center rounded-md bg-muted">
                          <FileAudio className="size-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {recording.source.replaceAll('_', ' ')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {recording.mime_type ?? 'Private audio'} · {recording.status}
                          </p>
                        </div>
                      </div>
                      {canDownload && recording.object_file_id ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={downloadingId === recording.id}
                          onClick={() => {
                            setDownloadingId(recording.id);
                            download.mutate(recording.object_file_id as string);
                          }}
                        >
                          <Download className="size-3.5" />
                          {downloadingId === recording.id ? 'Authorizing…' : 'Download'}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {recording.object_file_id ? 'Download permission required' : 'Not ready'}
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No private recording is attached.</p>
                )}
                {download.isError && (
                  <p className="text-xs text-destructive">
                    A secure recording URL could not be created.
                  </p>
                )}
              </CardContent>
            </Card>
            {data.transcript && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Transcript</CardTitle>
                  <CardDescription>
                    {data.transcript.language ?? 'Language unavailable'} · {data.transcript.status}
                  </CardDescription>
                </CardHeader>
                <CardContent className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {data.transcript.text ?? 'Transcript processing has not produced text yet.'}
                  {data.transcript.truncated && (
                    <p className="mt-3 text-xs font-medium text-amber-700">
                      This view is truncated to protect response size.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
            {data.ai_summary && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">AI summary</CardTitle>
                  <CardDescription>
                    Existing reviewed output; viewing it does not consume credits.
                  </CardDescription>
                </CardHeader>
                <CardContent className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {data.ai_summary.summary}
                </CardContent>
              </Card>
            )}
            {data.call_source === 'PROVIDER' && (
              <Alert>
                <Info className="size-4" />
                <div>
                  <AlertTitle>Provider record is read only</AlertTitle>
                  <AlertDescription>
                    {data.provider_name ?? 'Calling provider'} synchronization is available only
                    after a documented, tenant-mapped call adapter is configured. No browser-side
                    sync or provider recording URL is exposed.
                  </AlertDescription>
                </div>
              </Alert>
            )}
            {canUpdate && data.can_finalize && (
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">Finalize pending call</CardTitle>
                  <CardDescription>
                    Outcome changes use the current record version and are fully audited.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="grid gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      finalizationRequestId.current ??= globalThis.crypto.randomUUID();
                      finalize.mutate({
                        callId: data.id,
                        expectedVersion: data.version,
                        endedAt: new Date(String(form.get('endedAt'))).toISOString(),
                        outcome,
                        notes: String(form.get('notes') ?? ''),
                        requestId: finalizationRequestId.current,
                      });
                    }}
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="grid gap-1.5 text-sm font-medium">
                        Ended at
                        <Input
                          name="endedAt"
                          type="datetime-local"
                          required
                          defaultValue={initialEndedAt}
                        />
                      </label>
                      <div className="grid gap-1.5 text-sm font-medium">
                        Outcome
                        <Select
                          value={outcome}
                          onValueChange={(value) =>
                            setOutcome(value as FinalizeManualCallInput['outcome'])
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {outcomeOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Notes <span className="font-normal text-muted-foreground">(optional)</span>
                      <Textarea
                        name="notes"
                        maxLength={4000}
                        rows={3}
                        defaultValue={data.notes ?? ''}
                      />
                    </label>
                    {finalize.isError && (
                      <p className="text-sm text-destructive">
                        {isCallVersionConflict(finalize.error)
                          ? 'This call changed elsewhere. Reload the detail before submitting again.'
                          : 'The call could not be finalized. Check the end time and outcome.'}
                      </p>
                    )}
                    <Button type="submit" disabled={finalize.isPending}>
                      {finalize.isPending ? 'Finalizing…' : 'Finalize call'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CallTable({
  data,
  query,
  role,
  isFetching,
  onQueryChange,
  onOpen,
}: {
  data: CallWorkspaceResult;
  query: CallQuery;
  role: string;
  isFetching: boolean;
  onQueryChange: (next: Partial<CallQuery>) => void;
  onOpen: (call: CallRecord) => void;
}) {
  const columns = useMemo<ColumnDef<CallRecord>[]>(
    () => [
      {
        accessorKey: 'customer_name',
        header: 'Customer',
        cell: ({ row }) => (
          <div>
            {row.original.customer_id ? (
              <Link
                className="font-semibold hover:text-primary hover:underline"
                href={`/${role}/customers/${row.original.customer_id}`}
              >
                {row.original.customer_name ?? 'Restricted party'}
              </Link>
            ) : (
              <p className="font-semibold">{row.original.customer_name ?? 'Restricted party'}</p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {row.original.lead_id
                ? `Lead ${row.original.lead_id.slice(0, 8).toUpperCase()}`
                : row.original.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'phone',
        header: 'Phone',
        cell: ({ getValue }) => {
          const phone = getValue<string | null>();
          return phone ? (
            <a className="font-medium text-blue-700 hover:underline" href={`tel:${phone}`}>
              {phone}
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        id: 'callContext',
        header: 'Call',
        cell: ({ row }) => (
          <div className="space-y-1">
            <div className="flex gap-1">
              <StatusBadge value={row.original.direction} />
              <StatusBadge value={row.original.call_source} />
            </div>
            <p className="text-xs text-muted-foreground">
              {row.original.provider_name ?? 'Manually logged'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'started_at',
        header: 'Date & time',
        cell: ({ row }) => (
          <div>
            <p className="text-sm">{formatDate(row.original.started_at)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDuration(row.original.duration_seconds)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'outcome',
        header: 'Outcome',
        cell: ({ row }) => (
          <div className="space-y-1">
            {row.original.outcome ? (
              <StatusBadge value={row.original.outcome} />
            ) : (
              <span className="text-xs text-muted-foreground">Awaiting outcome</span>
            )}
            <p className="text-xs text-muted-foreground">{row.original.status}</p>
          </div>
        ),
      },
      {
        accessorKey: 'caller_name',
        header: 'Caller',
        cell: ({ row }) => (
          <div>
            <p className="text-sm font-medium">{row.original.caller_name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.original.caller_role ?? row.original.team_name ?? row.original.branch_name}
            </p>
          </div>
        ),
      },
      {
        id: 'intelligence',
        header: 'Recording / AI',
        cell: ({ row }) => (
          <div className="space-y-1 text-xs">
            <p>
              {row.original.recording_available
                ? 'Recording ready'
                : (row.original.recording_status ?? 'No recording')}
            </p>
            <p className="text-muted-foreground">
              {row.original.transcript_status ?? 'No transcript'}
              {row.original.ai_summary_available ? ' · AI summary' : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'action',
        header: '',
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => onOpen(row.original)}>
            Open
          </Button>
        ),
      },
    ],
    [onOpen, role],
  );
  // TanStack Table returns an imperative model; React Compiler intentionally skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data.records,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: data.total,
  });
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b p-4">
        <div className="flex flex-col gap-3">
          <div className="relative min-w-0 lg:max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              maxLength={160}
              placeholder="Search call UUID, customer, phone or provider call ID…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={query.status}
              onValueChange={(status) =>
                onQueryChange({ status: status as CallStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={query.outcome}
              onValueChange={(outcome) =>
                onQueryChange({ outcome: outcome as CallOutcomeFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[175px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="connected">Connected</SelectItem>
                <SelectItem value="no-answer">No answer</SelectItem>
                <SelectItem value="busy">Busy</SelectItem>
                <SelectItem value="switched-off">Switched off</SelectItem>
                <SelectItem value="callback-required">Callback required</SelectItem>
                <SelectItem value="wrong-number">Wrong number</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={query.source}
              onValueChange={(source) =>
                onQueryChange({ source: source as CallSourceFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="provider">Provider</SelectItem>
                <SelectItem value="personal-manual">Personal / manual</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(sort) => onQueryChange({ sort: sort as CallQuery['sort'], page: 1 })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="started:desc">Called: newest</SelectItem>
                <SelectItem value="started:asc">Called: oldest</SelectItem>
                <SelectItem value="duration:desc">Duration: longest</SelectItem>
                <SelectItem value="duration:asc">Duration: shortest</SelectItem>
                <SelectItem value="customer:asc">Customer: A–Z</SelectItem>
                <SelectItem value="customer:desc">Customer: Z–A</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as CallQuery['pageSize'], page: 1 })
              }
            >
              <SelectTrigger className="w-[105px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={`overflow-x-auto transition-opacity ${isFetching ? 'opacity-65' : ''}`}>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <PhoneCall className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-2 font-medium">No calls match this view</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try another filter or page-local search.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {data.total ? (query.page - 1) * query.pageSize + 1 : 0}–
            {Math.min(query.page * query.pageSize, data.total)} of {data.total}
          </p>
          <div className="flex items-center gap-2">
            <span className="mr-2 text-xs text-muted-foreground">
              Page {query.page} of {pages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={query.page >= pages}
              onClick={() => onQueryChange({ page: query.page + 1 })}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CallWorkspace({ spec, role }: { spec: PageSpec; role: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState<CallQuery>(() => parseCallQuery(searchParams));
  const [createOpen, setCreateOpen] = useState(false);
  const [manualTimes, setManualTimes] = useState({ startedAt: '', endedAt: '' });
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [detailEndedAt, setDetailEndedAt] = useState('');
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const queryClient = useQueryClient();
  const permissions = useQuery({
    queryKey: ['call-workspace-permissions'],
    queryFn: fetchCallWorkspacePermissions,
    staleTime: 60_000,
  });
  const workspace = useQuery({
    queryKey: [
      'call-workspace',
      permissions.data?.organizationId,
      permissions.data?.scopeKey,
      requestQuery,
    ],
    queryFn: ({ signal }) => fetchCallWorkspace(requestQuery, signal),
    enabled: permissions.isSuccess,
    placeholderData: keepPreviousData,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    { resource: 'communications', queryKeys: [['call-workspace'], ['call-detail']] },
  ]);

  const onQueryChange = useCallback(
    (next: Partial<CallQuery>) => {
      const updated = { ...query, ...next };
      setQuery(updated);
      const queryString = toCallQueryString(updated);
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['call-workspace'] });
    if (selectedCallId)
      void queryClient.invalidateQueries({ queryKey: ['call-detail', selectedCallId] });
  }, [queryClient, selectedCallId]);
  const openCall = useCallback((call: CallRecord) => {
    setDetailEndedAt(dateTimeLocal(new Date()));
    setSelectedCallId(call.id);
  }, []);

  if (permissions.isPending || workspace.isPending) return <PageSkeleton />;
  if (permissions.isError || workspace.isError)
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">Calls are not available yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your session, data scope, or the required Calls workspace migration needs attention.
            Reference: GDM-CALLS-QUERY.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => {
              void permissions.refetch();
              void workspace.refetch();
            }}
          >
            <RotateCcw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  if (!workspace.data || !permissions.data) return null;

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {!spec.readOnly && permissions.data.canCreate && (
          <Button
            className="shrink-0 sm:mt-7"
            onClick={() => {
              const now = new Date();
              setManualTimes({
                startedAt: dateTimeLocal(new Date(now.getTime() - 5 * 60_000)),
                endedAt: dateTimeLocal(now),
              });
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Log call
          </Button>
        )}
      </div>
      <div className="space-y-6">
        <KpiGrid metrics={callMetrics(workspace.data.kpis)} />
        <Card className="shadow-none">
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Call activity</CardTitle>
            <CardDescription>
              Total and connected calls over the last seven days in your authorized scope.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={workspace.data.trend}
              seriesNames={chartSeries}
              className="h-[280px]"
            />
          </CardContent>
        </Card>
        <CallTable
          data={workspace.data}
          query={query}
          role={role}
          isFetching={workspace.isFetching}
          onQueryChange={onQueryChange}
          onOpen={openCall}
        />
      </div>
      {permissions.data.canCreate && (
        <ManualCallDialog
          key={manualTimes.endedAt || 'manual-call'}
          organizationId={permissions.data.organizationId}
          open={createOpen}
          initialStartedAt={manualTimes.startedAt}
          initialEndedAt={manualTimes.endedAt}
          onOpenChange={setCreateOpen}
          onCreated={invalidate}
        />
      )}
      <CallDetailSheet
        key={selectedCallId ?? 'no-call'}
        callId={selectedCallId}
        initialEndedAt={detailEndedAt}
        role={role}
        canUpdate={!spec.readOnly && permissions.data.canUpdate}
        canDownload={permissions.data.canDownload}
        onOpenChange={(open) => !open && setSelectedCallId(null)}
        onUpdated={invalidate}
      />
    </div>
  );
}
