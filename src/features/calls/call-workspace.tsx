'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  FileUp,
  Info,
  MoreHorizontal,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Phone,
  PhoneCall,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  TriangleAlert,
  RadioTower,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
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
import type { PageSpec } from '@/lib/domain';
import {
  createCallRecordingDownload,
  fetchCallDetail,
  fetchCallPartyOptions,
  fetchCallProviderOptions,
  fetchCallScopeOptions,
  fetchCallWorkspace,
  fetchCallWorkspacePermissions,
  finalizeManualCall,
  logCompletedManualCall,
  startProviderCall,
  uploadManualCallRecording,
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

function prettyCallValue(value: string) {
  return value
    .toLocaleLowerCase()
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function CallDirectionIcon({ direction }: { direction: string }) {
  if (direction === 'INBOUND') return <PhoneIncoming className="size-4 text-blue-600" />;
  if (direction === 'MISSED') return <PhoneMissed className="size-4 text-orange-500" />;
  return <PhoneOutgoing className="size-4 text-emerald-600" />;
}

function CallKpis({ data }: { data: CallWorkspaceResult }) {
  const cards = [
    {
      label: 'Total calls',
      value: data.kpis.total_today.toLocaleString('en-IN'),
      icon: PhoneCall,
      tone: 'bg-blue-50 text-blue-600',
    },
    {
      label: 'Connected',
      value: data.kpis.connected_today.toLocaleString('en-IN'),
      icon: Phone,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      label: 'Not connected',
      value: data.kpis.not_connected_today.toLocaleString('en-IN'),
      icon: PhoneMissed,
      tone: 'bg-orange-50 text-orange-500',
    },
    {
      label: 'Talk time',
      value: formatDuration(data.kpis.talk_time_seconds),
      icon: Clock3,
      tone: 'bg-violet-50 text-violet-600',
    },
    {
      label: 'Average duration',
      value: formatDuration(data.kpis.average_duration_seconds),
      icon: Clock3,
      tone: 'bg-blue-50 text-blue-600',
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.label} className="shadow-none">
          <CardContent className="flex items-center gap-3 p-4">
            <div className={`grid size-11 shrink-0 place-items-center rounded-full ${card.tone}`}>
              <card.icon className="size-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
              <p className="mt-1 text-xl font-bold tracking-tight">{card.value}</p>
              <p className="mt-1 text-[11px] text-emerald-600">Live from your assigned scope</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
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
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [providerId, setProviderId] = useState('');
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
  const providerOptions = useQuery({
    queryKey: ['call-provider-options', organizationId, selectedBranchId],
    queryFn: () => fetchCallProviderOptions(selectedBranchId),
    enabled: open && Boolean(selectedParty?.lead_id && selectedBranchId),
  });
  const selectedProviderId = providerId || providerOptions.data?.[0]?.id || '';
  const providerCall = useMutation({
    mutationFn: () => {
      if (!selectedParty?.lead_id || !selectedProviderId)
        throw new Error('PROVIDER_CALL_SELECTION_REQUIRED');
      return startProviderCall({
        organizationId,
        connectionId: selectedProviderId,
        leadId: selectedParty.lead_id,
        requestId: globalThis.crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      onCreated();
      close(false);
    },
  });
  const mutation = useMutation({
    mutationFn: async (
      input: Parameters<typeof logCompletedManualCall>[0] & { audioFile: File | null },
    ) => {
      const created = await logCompletedManualCall(input);
      if (input.audioFile)
        await uploadManualCallRecording({
          organizationId: input.organizationId,
          branchId: input.branchId,
          callId: created.call_id,
          file: input.audioFile,
          requestId: globalThis.crypto.randomUUID(),
        });
      return created;
    },
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
      setAudioFile(null);
      setProviderId('');
      providerCall.reset();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Call customer</DialogTitle>
          <DialogDescription>
            Choose an authorized customer or lead, then call normally, use a connected IVR, or log a
            completed call.
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
              audioFile,
            });
          }}
        >
          {selectedParty ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-slate-50 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{selectedParty.customer_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {selectedParty.phone ?? 'No phone'} · {selectedParty.context_label}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setPartyKey('')}>
                Change
              </Button>
            </div>
          ) : (
            <div className="grid gap-2">
              <label className="text-sm font-medium">Select customer or lead</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={partySearch}
                  onChange={(event) => setPartySearch(event.target.value)}
                  className="pl-9"
                  maxLength={160}
                  placeholder="Search customer name, phone or UUID…"
                  autoFocus
                />
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border">
                {parties.isPending ? (
                  <p className="p-4 text-sm text-muted-foreground">Loading authorized people…</p>
                ) : parties.data?.length ? (
                  parties.data.map((party: CallPartyOption) => (
                    <button
                      key={party.key}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 border-b px-3 py-3 text-left last:border-b-0 hover:bg-slate-50"
                      onClick={() => {
                        setPartyKey(party.key);
                        if (party.branch_id) setBranchId(party.branch_id);
                        if (party.lead_id) setTeamId(party.team_id ?? 'none');
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {party.customer_name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {party.phone ?? 'No phone'} · {party.context_label}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-blue-600" />
                    </button>
                  ))
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    No authorized customers or leads match this search.
                  </p>
                )}
              </div>
              {parties.isError && (
                <p className="text-xs text-destructive">Authorized call parties could not load.</p>
              )}
            </div>
          )}
          {selectedParty && (
            <>
              <div className="grid gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-semibold">Start a call</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Normal calls open your device dialer. Twilio calls your registered number first,
                    then securely bridges the customer and records the connected conversation.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {selectedParty.phone ? (
                    <Button type="button" variant="outline" asChild>
                      <a href={`tel:${selectedParty.phone}`}>
                        <Phone className="size-4" /> Normal phone
                      </a>
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" disabled>
                      <Phone className="size-4" /> Phone unavailable
                    </Button>
                  )}
                  <Button
                    type="button"
                    disabled={
                      providerOptions.isPending ||
                      !selectedParty.lead_id ||
                      !selectedProviderId ||
                      providerCall.isPending
                    }
                    onClick={() => providerCall.mutate()}
                  >
                    <RadioTower className="size-4" />
                    {providerCall.isPending ? 'Starting Twilio…' : 'Call with IVR'}
                  </Button>
                </div>
                {providerOptions.data && providerOptions.data.length > 1 && (
                  <Select value={selectedProviderId} onValueChange={setProviderId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select calling provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.data.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.display_name}
                          {provider.caller_id_label ? ` · ${provider.caller_id_label}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!selectedParty.lead_id ? (
                  <p className="text-xs text-amber-700">
                    Link this customer to an authorized lead before using a connected IVR.
                  </p>
                ) : providerOptions.isSuccess && !providerOptions.data.length ? (
                  <p className="text-xs text-muted-foreground">
                    No Twilio connection is mapped to this branch yet. A Client Admin or System
                    Administrator must connect it; normal calling and manual logging remain
                    available.
                  </p>
                ) : null}
                {providerCall.isError && (
                  <p className="text-xs text-destructive">
                    Twilio could not start the call. Use normal calling or ask an administrator to
                    test the connection.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> Log a completed call
                <span className="h-px flex-1 bg-border" />
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
                  <Input
                    name="endedAt"
                    type="datetime-local"
                    required
                    defaultValue={initialEndedAt}
                  />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                Notes <span className="font-normal text-muted-foreground">(optional)</span>
                <Textarea name="notes" maxLength={4000} rows={4} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Call recording <span className="font-normal text-muted-foreground">(optional)</span>
                <div className="flex min-h-11 items-center gap-3 rounded-md border bg-white px-3 py-2">
                  <FileUp className="size-4 shrink-0 text-blue-600" />
                  <Input
                    type="file"
                    accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/ogg,audio/webm"
                    className="h-auto border-0 p-0 text-xs shadow-none file:mr-3 file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-blue-700"
                    onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
                  />
                </div>
                <span className="text-xs font-normal text-muted-foreground">
                  MP3, MP4 audio, WAV, OGG or WebM up to 100 MB. Stored privately in Tigris.
                </span>
              </label>
              {mutation.isError && (
                <Alert variant="destructive">
                  <TriangleAlert className="size-4" />
                  <div>
                    <AlertTitle>Call could not be finalized</AlertTitle>
                    <AlertDescription>
                      Check the party, branch and times. If the initial log was saved, it appears as
                      a pending call and can be finalized from its detail panel.
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
            </>
          )}
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
  const [recordingFile, setRecordingFile] = useState<File | null>(null);
  const download = useMutation({
    mutationFn: createCallRecordingDownload,
    onSuccess: (result) => {
      setDownloadingId(null);
      window.location.assign(result.download_url);
    },
    onError: () => setDownloadingId(null),
  });
  const uploadRecording = useMutation({
    mutationFn: (file: File) => {
      if (!data) throw new Error('CALL_DETAIL_NOT_READY');
      return uploadManualCallRecording({
        organizationId: data.organization_id,
        branchId: data.branch_id,
        callId: data.id,
        file,
        requestId: globalThis.crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      setRecordingFile(null);
      onUpdated();
      void detail.refetch();
    },
  });
  const data = detail.data;

  if (!callId) return null;
  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              className="font-medium text-blue-600 hover:underline"
              onClick={() => onOpenChange(false)}
            >
              Calls
            </button>
            <ChevronRight className="size-3" />
            <span>Call with {data?.customer_name ?? 'customer'}</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Sales Consultant Call</h1>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            finalizationRequestId.current = null;
            finalize.reset();
            onOpenChange(false);
          }}
        >
          <ChevronLeft className="size-4" /> Back to calls
        </Button>
      </div>
      {detail.isPending && <div className="mt-8 text-sm text-muted-foreground">Loading call…</div>}
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
        <div className="space-y-4">
          <Card className="shadow-none">
            <CardContent className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-5">
              <div className="flex items-center gap-3 xl:border-r">
                <div className="grid size-12 shrink-0 place-items-center rounded-full bg-blue-50 text-lg font-bold text-blue-600">
                  {(data.customer_name ?? 'C').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {data.customer_name ?? 'Restricted party'}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {data.phone ?? 'Phone hidden'}
                  </p>
                </div>
              </div>
              <DetailValue label="Call type">
                <span className="flex items-center gap-2">
                  <CallDirectionIcon direction={data.direction} /> {prettyCallValue(data.direction)}
                </span>
              </DetailValue>
              <DetailValue label="Last call">
                <span className="block">{formatDate(data.started_at)}</span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  by {data.caller_name} · {formatDuration(data.duration_seconds)}
                </span>
              </DetailValue>
              <DetailValue label="Outcome">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge value={data.status} />
                  {data.outcome && <StatusBadge value={data.outcome} />}
                </div>
              </DetailValue>
              <DetailValue label={data.lead_id ? 'Lead ID' : 'Call ID'}>
                {(data.lead_id ?? data.id).slice(0, 8).toUpperCase()}
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {data.branch_name}
                </span>
              </DetailValue>
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-12">
            <Card className="shadow-none xl:col-span-3">
              <CardHeader>
                <CardTitle className="text-sm">Make a call</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center text-center">
                <a
                  href={data.phone ? `tel:${data.phone}` : undefined}
                  className="grid size-24 place-items-center rounded-full border-[12px] border-blue-50 bg-blue-600 text-white shadow-sm"
                >
                  <PhoneCall className="size-9" />
                </a>
                <p className="mt-4 font-semibold">Click to call</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.phone ?? 'Phone unavailable'}
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4" disabled={!data.phone}>
                  <a href={data.phone ? `tel:${data.phone}` : undefined}>
                    <Phone className="size-3.5" /> Open dialer
                  </a>
                </Button>
              </CardContent>
            </Card>
            <Card className="shadow-none xl:col-span-6">
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Call workspace</CardTitle>
                  <CardDescription>{prettyCallValue(data.call_source)} record</CardDescription>
                </div>
                <span className="font-mono text-sm font-semibold">
                  {formatDuration(data.duration_seconds)}
                </span>
              </CardHeader>
              <CardContent className="flex min-h-52 flex-col items-center justify-center text-center">
                <div className="grid size-16 place-items-center rounded-full bg-emerald-50 text-xl font-bold text-emerald-600">
                  {(data.customer_name ?? 'C').slice(0, 1).toUpperCase()}
                </div>
                <p className="mt-3 font-semibold">{data.customer_name ?? 'Restricted party'}</p>
                <p className="text-xs text-muted-foreground">{data.phone ?? 'Phone hidden'}</p>
                <div className="mt-6 flex items-center gap-5 text-xs text-muted-foreground">
                  <span className="grid gap-1 justify-items-center">
                    <div className="grid size-9 place-items-center rounded-full border">
                      <Phone className="size-4" />
                    </div>
                    {prettyCallValue(data.direction)}
                  </span>
                  <span className="grid gap-1 justify-items-center">
                    <div className="grid size-9 place-items-center rounded-full border">
                      <Clock3 className="size-4" />
                    </div>
                    {formatDuration(data.duration_seconds)}
                  </span>
                  <span className="grid gap-1 justify-items-center">
                    <div className="grid size-9 place-items-center rounded-full border">
                      <FileAudio className="size-4" />
                    </div>
                    {data.recordings.length ? 'Recorded' : 'No audio'}
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-none xl:col-span-3">
              <CardHeader>
                <CardTitle className="text-sm">Call notes</CardTitle>
              </CardHeader>
              <CardContent className="min-h-52 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {data.notes || 'No notes have been added for this call.'}
              </CardContent>
            </Card>
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
              {canUpdate && data.call_source === 'PERSONAL_MANUAL' && (
                <div className="grid gap-3 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">Upload call audio</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Attach another recording to this call. Files stay private in Tigris.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      type="file"
                      accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/ogg,audio/webm"
                      className="text-xs"
                      onChange={(event) => setRecordingFile(event.target.files?.[0] ?? null)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={!recordingFile || uploadRecording.isPending}
                      onClick={() => recordingFile && uploadRecording.mutate(recordingFile)}
                    >
                      <FileUp className="size-3.5" />
                      {uploadRecording.isPending ? 'Uploading…' : 'Upload audio'}
                    </Button>
                  </div>
                  {uploadRecording.isError && (
                    <p className="text-xs text-destructive">
                      The recording could not be uploaded. Check the audio format and size.
                    </p>
                  )}
                </div>
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
                  {data.provider_name ?? 'Calling provider'} synchronization is available only after
                  a documented, tenant-mapped call adapter is configured. No browser-side sync or
                  provider recording URL is exposed.
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
    </div>
  );
}

function CallRowPreview({ callId, onOpen }: { callId: string; onOpen: () => void }) {
  const detail = useQuery({
    queryKey: ['call-detail', callId],
    queryFn: () => fetchCallDetail(callId),
  });
  if (detail.isPending)
    return <div className="p-5 text-sm text-muted-foreground">Loading call preview…</div>;
  if (!detail.data)
    return <div className="p-5 text-sm text-muted-foreground">Call preview is unavailable.</div>;
  const data = detail.data;
  const readyRecording = data.recordings.find((recording) => recording.object_file_id);
  return (
    <div className="grid gap-5 border-t bg-slate-50/60 p-5 lg:grid-cols-3">
      <div className="lg:border-r lg:pr-5">
        <p className="text-xs font-semibold uppercase tracking-wide">Recording</p>
        <div className="mt-3 flex items-center gap-3 rounded-lg border bg-white p-3">
          <div className="grid size-9 place-items-center rounded-full bg-blue-600 text-white">
            <Play className="size-4 fill-current" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {readyRecording ? 'Private recording ready' : 'No recording attached'}
            </p>
            <p className="text-xs text-muted-foreground">{formatDuration(data.duration_seconds)}</p>
          </div>
        </div>
        <p className="mt-4 text-xs font-semibold">Call notes</p>
        <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
          {data.notes || 'No notes were recorded for this call.'}
        </p>
      </div>
      <div className="lg:border-r lg:pr-5">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
          <FileText className="size-4 text-blue-600" /> Transcript preview
        </p>
        <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {data.transcript?.text || 'Transcript is not available for this call.'}
        </p>
      </div>
      <div>
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
          <Sparkles className="size-4 text-violet-600" /> AI summary preview
        </p>
        <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {data.ai_summary?.summary || 'AI summary is not available for this call.'}
        </p>
        <Button variant="link" className="mt-2 h-auto p-0 text-xs" onClick={onOpen}>
          Open full call workspace <ChevronRight className="size-3" />
        </Button>
      </div>
    </div>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const columns = useMemo<ColumnDef<CallRecord>[]>(
    () => [
      {
        id: 'expand',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            aria-label={expandedId === row.original.id ? 'Collapse call' : 'Expand call'}
            onClick={() =>
              setExpandedId((current) => (current === row.original.id ? null : row.original.id))
            }
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${expandedId === row.original.id ? 'rotate-180' : ''}`}
            />
          </Button>
        ),
      },
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
        header: 'Call direction',
        cell: ({ row }) => (
          <div className="flex items-center gap-2 text-xs font-medium">
            <CallDirectionIcon direction={row.original.direction} />
            {prettyCallValue(row.original.direction)}
          </div>
        ),
      },
      {
        accessorKey: 'started_at',
        header: 'Call time',
        cell: ({ row }) => <p className="text-xs">{formatDate(row.original.started_at)}</p>,
      },
      {
        accessorKey: 'duration_seconds',
        header: 'Duration',
        cell: ({ row }) => (
          <span className="text-xs">{formatDuration(row.original.duration_seconds)}</span>
        ),
      },
      {
        accessorKey: 'outcome',
        header: 'Status',
        cell: ({ row }) =>
          row.original.outcome ? (
            <StatusBadge value={row.original.outcome} />
          ) : (
            <StatusBadge value={row.original.status} />
          ),
      },
      {
        id: 'recording',
        header: 'Recording',
        cell: ({ row }) =>
          row.original.recording_available ? (
            <Play className="size-4 text-blue-600" />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'transcript',
        header: 'Transcript',
        cell: ({ row }) =>
          row.original.transcript_status ? (
            <FileText className="size-4 text-blue-600" />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'ai',
        header: 'AI summary',
        cell: ({ row }) =>
          row.original.ai_summary_available ? (
            <Sparkles className="size-4 text-violet-600" />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            {row.original.phone && (
              <Button variant="ghost" size="icon" className="size-8" asChild>
                <a href={`tel:${row.original.phone}`} aria-label="Call customer">
                  <Phone className="size-4 text-emerald-600" />
                </a>
              </Button>
            )}
            <Button
              size="icon"
              className="size-8"
              variant="ghost"
              onClick={() => onOpen(row.original)}
              aria-label="Open call workspace"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </div>
        ),
      },
    ],
    [expandedId, onOpen, role],
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
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
            <div>
              <CardTitle className="text-sm">
                Calls ({data.total.toLocaleString('en-IN')})
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                Live calls in your authorized sales scope
              </CardDescription>
            </div>
            <div className="relative min-w-0 lg:w-72">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
                className="pl-9"
                maxLength={160}
                placeholder="Search call UUID, customer, phone or provider call ID…"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
                  <Fragment key={row.id}>
                    <TableRow>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="whitespace-nowrap align-middle">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {expandedId === row.original.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={columns.length} className="p-0">
                          <CallRowPreview
                            callId={row.original.id}
                            onOpen={() => onOpen(row.original)}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
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
  const [activeTab, setActiveTab] = useState<'today' | 'history' | 'missed' | 'recordings' | 'ai'>(
    'today',
  );
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

  if (selectedCallId)
    return (
      <CallDetailSheet
        key={selectedCallId}
        callId={selectedCallId}
        initialEndedAt={detailEndedAt}
        role={role}
        canUpdate={!spec.readOnly && permissions.data.canUpdate}
        canDownload={permissions.data.canDownload}
        onOpenChange={(open) => !open && setSelectedCallId(null)}
        onUpdated={invalidate}
      />
    );

  const tabRecords = workspace.data.records.filter((record) => {
    if (activeTab === 'history') return true;
    if (activeTab === 'today')
      return new Date(record.started_at).toDateString() === new Date().toDateString();
    if (activeTab === 'missed')
      return ['NO_ANSWER', 'BUSY', 'SWITCHED_OFF'].includes(record.outcome ?? '');
    if (activeTab === 'recordings') return record.recording_available;
    return record.ai_summary_available;
  });
  const displayedWorkspace =
    activeTab === 'history'
      ? workspace.data
      : { ...workspace.data, records: tabRecords, total: tabRecords.length };
  const tabs = [
    { id: 'today' as const, label: "Today's calls" },
    { id: 'history' as const, label: 'Call history' },
    { id: 'missed' as const, label: 'Missed calls' },
    { id: 'recordings' as const, label: 'Recordings' },
    { id: 'ai' as const, label: 'AI summary' },
  ];

  return (
    <div className="mx-auto max-w-[1800px]">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link href={`/${role}/dashboard`} className="font-medium text-blue-600 hover:underline">
              Dashboard
            </Link>
            <ChevronRight className="size-3" /> <span>Calls</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Calls</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage and monitor your outgoing and incoming customer calls in one place.
          </p>
        </div>
        {!spec.readOnly && permissions.data.canCreate && (
          <Button
            className="shrink-0"
            onClick={() => {
              const now = new Date();
              setManualTimes({
                startedAt: dateTimeLocal(new Date(now.getTime() - 5 * 60_000)),
                endedAt: dateTimeLocal(now),
              });
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" /> Call / log
          </Button>
        )}
      </div>
      <div className="mt-6 flex h-10 gap-2 overflow-x-auto border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`relative h-full shrink-0 px-3 text-xs font-semibold ${
              activeTab === tab.id ? 'text-blue-700' : 'text-[#263550] hover:text-blue-700'
            }`}
            style={activeTab === tab.id ? { boxShadow: 'inset 0 -2px 0 #2563eb' } : undefined}
            onClick={() => {
              setActiveTab(tab.id);
              onQueryChange({ page: 1 });
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="mt-6 space-y-6">
        <CallKpis data={workspace.data} />
        <CallTable
          data={displayedWorkspace}
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
    </div>
  );
}
