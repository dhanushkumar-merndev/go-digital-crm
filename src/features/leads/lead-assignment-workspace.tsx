'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { LeadAssignmentSkeleton } from '@/components/skeletons';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { assignLead } from './lead-workspace-api';
import {
  fetchLeadAssignmentWorkspace,
  type LeadAssignmentAudience,
  type LeadAssignmentWorkspace,
} from './lead-assignment-workspace-api';

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function age(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function temperatureVariant(value: string | null) {
  if (value === 'HOT') return 'destructive' as const;
  if (value === 'WARM') return 'warning' as const;
  // DORMANT is do-not-disturb, not a colder COLD, so it must not share the
  // COLD styling: someone scanning the column has to see that this lead is
  // suppressed from outbound messaging. See AGENTS.md 9.7.
  if (value === 'DORMANT') return 'secondary' as const;
  return 'info' as const;
}

function AssignmentQueue({
  result,
  selectedId,
  onSelect,
  scopeLabel,
}: {
  result: LeadAssignmentWorkspace;
  selectedId: string | null;
  onSelect: (id: string) => void;
  scopeLabel: string;
}) {
  return (
    <Card className="min-h-[490px] overflow-hidden shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between text-base">
          Unassigned leads <Badge variant="info">{result.total}</Badge>
        </CardTitle>
        <CardDescription>{scopeLabel}</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[520px] space-y-2 overflow-y-auto p-3">
        {result.records.map((lead) => (
          <button
            key={lead.id}
            type="button"
            onClick={() => onSelect(lead.id)}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${selectedId === lead.id ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500' : 'hover:bg-slate-50'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{lead.customer_name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{lead.phone}</p>
              </div>
              <Badge variant={temperatureVariant(lead.temperature)}>
                {lead.temperature ?? 'No temp'}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{lead.source}</span>
              <span>{lead.interested_model ?? 'Model not recorded'}</span>
              <span>{age(lead.created_at)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">{lead.team_name}</span>
              <span className="text-muted-foreground">
                {lead.assignment_mode === 'ROUND_ROBIN' ? 'Round robin' : 'Manual'}
              </span>
            </div>
          </button>
        ))}
        {!result.records.length && (
          <div className="grid min-h-64 place-items-center text-center text-sm text-muted-foreground">
            No unassigned leads match this queue.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function LeadAssignmentWorkspace({
  audience = 'TEAM_MANAGER',
}: {
  audience?: LeadAssignmentAudience;
}) {
  const session = useWorkspaceSession();
  const salesConsultantCache = useSalesConsultantCache();
  const queryScope = workspaceQueryScope(session);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConsultantId, setSelectedConsultantId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);
  const query = useQuery({
    queryKey: ['lead-assignment', ...queryScope, audience, debouncedSearch, page, pageSize],
    queryFn: ({ signal }) =>
      fetchLeadAssignmentWorkspace({ search: debouncedSearch, page, pageSize }, audience, signal),
    staleTime: 30_000,
  });
  const selectedLead = useMemo(() => {
    const rows = query.data?.records ?? [];
    return rows.find((lead) => lead.id === selectedId) ?? rows[0] ?? null;
  }, [query.data?.records, selectedId]);
  const eligibleConsultants = useMemo(() => {
    if (!selectedLead) return [];
    return (query.data?.consultants ?? []).filter(
      (consultant) =>
        consultant.team_id === selectedLead.team_id &&
        (selectedLead.assignment_kind === 'FRESH'
          ? consultant.eligible_for_fresh_leads
          : consultant.eligible_for_qualified_leads),
    );
  }, [query.data?.consultants, selectedLead]);
  const selectedConsultant =
    eligibleConsultants.find((consultant) => consultant.user_id === selectedConsultantId) ??
    eligibleConsultants[0] ??
    null;
  const assign = useMutation({
    mutationFn: () => {
      if (!selectedLead) throw new Error('ASSIGNMENT_LEAD_REQUIRED');
      if (!selectedConsultant) throw new Error('ASSIGNMENT_CONSULTANT_REQUIRED');
      return assignLead({
        leadId: selectedLead.id,
        userId: selectedConsultant.user_id,
        assignmentKind: selectedLead.assignment_kind,
        reason:
          selectedLead.assignment_mode === 'ROUND_ROBIN'
            ? 'Assigned through configured round robin queue.'
            : `Assigned by ${audience === 'SHOWROOM_MANAGER' ? 'Showroom Manager' : 'Team Manager'} from assignment queue.`,
      });
    },
    onSuccess: async () => {
      setSelectedId(null);
      setSelectedConsultantId(null);
      await salesConsultantCache.settle('lead.assigned', { leadId: selectedId ?? undefined });
      toast.add({
        type: 'success',
        title: 'Lead assigned',
        description:
          selectedLead?.assignment_mode === 'ROUND_ROBIN'
            ? 'The configured round-robin rule selected an eligible consultant.'
            : 'The selected consultant now owns this lead.',
      });
    },
    onError: (error) => {
      toast.add({
        type: 'error',
        title: 'Lead was not assigned',
        description:
          error instanceof Error && error.message.includes('ASSIGNEE_NOT_ELIGIBLE')
            ? 'That consultant is no longer eligible. Refresh the queue and choose another consultant.'
            : 'The lead may have changed or is outside your managed team. Refresh and try again.',
      });
    },
  });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize));
  const isShowroom = audience === 'SHOWROOM_MANAGER';
  const queueScopeLabel = isShowroom
    ? 'Only unassigned leads in your authorized showroom branches are shown.'
    : 'Only leads in your managed team queue are shown.';

  if (query.isPending) return <LeadAssignmentSkeleton />;
  if (query.isError)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <h1 className="font-semibold">Lead assignment is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Confirm your active manager role, authorized scope and lead assignment permission.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-xs">
            <span className="text-primary">Dashboard</span>
            <span className="mx-2 text-muted-foreground">›</span>
            <span className="text-muted-foreground">Lead Assignment</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Lead Assignment</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isShowroom
              ? 'Distribute unassigned leads across eligible consultants in your authorized showroom branches.'
              : 'Distribute unassigned leads to eligible team consultants with the configured team rule.'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>
      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search lead, customer or mobile"
            />
          </div>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              setPageSize(Number(value) as 25 | 50 | 100);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="25">25 / page</SelectItem>
              <SelectItem value="50">50 / page</SelectItem>
              <SelectItem value="100">100 / page</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      {query.isPending || !query.data ? (
        <Card className="shadow-none">
          <CardContent className="p-10 text-sm text-muted-foreground">
            Loading assignment queue…
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_320px_minmax(0,1.1fr)]">
            <AssignmentQueue
              result={query.data}
              selectedId={selectedLead?.id ?? null}
              onSelect={setSelectedId}
              scopeLabel={queueScopeLabel}
            />
            <Card className="flex min-h-[490px] flex-col justify-center shadow-none">
              <CardContent className="space-y-5 p-5 text-center">
                {selectedLead ? (
                  <>
                    <span className="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-blue-600">
                      <UserRoundCheck className="size-6" />
                    </span>
                    <div>
                      <p className="font-semibold">{selectedLead.customer_name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {selectedLead.assignment_mode === 'ROUND_ROBIN'
                          ? 'Round robin assignment'
                          : 'Manual assignment'}
                      </p>
                    </div>
                    {selectedLead.assignment_mode === 'MANUAL_ASSIGNMENT' && (
                      <Select
                        value={selectedConsultant?.user_id ?? ''}
                        onValueChange={setSelectedConsultantId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose consultant" />
                        </SelectTrigger>
                        <SelectContent>
                          {eligibleConsultants.map((consultant) => (
                            <SelectItem key={consultant.user_id} value={consultant.user_id}>
                              {consultant.full_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      className="w-full"
                      disabled={!selectedConsultant || assign.isPending}
                      onClick={() => assign.mutate()}
                    >
                      {assign.isPending
                        ? 'Assigning…'
                        : selectedLead.assignment_mode === 'ROUND_ROBIN'
                          ? 'Assign via round robin'
                          : 'Assign selected lead'}
                      <ArrowRight className="size-4" />
                    </Button>
                    {!eligibleConsultants.length && (
                      <p className="text-xs text-destructive">
                        No eligible consultant is active for this lead type.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <UsersRound className="mx-auto size-8 text-muted-foreground" />
                    <p className="font-medium">Select an unassigned lead</p>
                  </>
                )}
              </CardContent>
            </Card>
            <Card className="min-h-[490px] overflow-hidden shadow-none">
              <CardHeader className="border-b">
                <CardTitle className="text-base">Eligible consultants</CardTitle>
                <CardDescription>
                  {isShowroom
                    ? 'Live workload in your authorized showroom teams.'
                    : 'Live workload within your managed teams.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="max-h-[520px] space-y-2 overflow-y-auto p-3">
                {query.data.consultants.map((consultant) => {
                  const eligible =
                    selectedLead &&
                    consultant.team_id === selectedLead.team_id &&
                    (selectedLead.assignment_kind === 'FRESH'
                      ? consultant.eligible_for_fresh_leads
                      : consultant.eligible_for_qualified_leads);
                  return (
                    <button
                      key={consultant.user_id}
                      type="button"
                      disabled={!eligible || selectedLead?.assignment_mode === 'ROUND_ROBIN'}
                      onClick={() => setSelectedConsultantId(consultant.user_id)}
                      className={`w-full rounded-lg border p-3 text-left ${selectedConsultant?.user_id === consultant.user_id ? 'border-blue-500 bg-blue-50' : ''} ${eligible ? 'hover:bg-slate-50' : 'opacity-55'}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="grid size-9 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                          {initials(consultant.full_name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{consultant.full_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {consultant.current_leads} current · {consultant.hot_leads} hot
                          </p>
                        </div>
                        <Badge variant={eligible ? 'success' : 'outline'}>
                          {eligible ? 'Eligible' : 'Unavailable'}
                        </Badge>
                      </div>
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * pageSize + (query.data.records.length ? 1 : 0)}–
              {Math.min(page * pageSize, query.data.total)} of {query.data.total} unassigned leads
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span>
                {page}/{totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <Card className="overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Recent assignments</CardTitle>
              <CardDescription>
                Assignment history is generated by the audited database transaction.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-y bg-muted/30 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">Time</th>
                    <th className="px-5 py-3 font-medium">Customer</th>
                    <th className="px-5 py-3 font-medium">Assigned to</th>
                    <th className="px-5 py-3 font-medium">Method</th>
                    <th className="px-5 py-3 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.recent_assignments.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">
                        {dateTime(row.created_at)}
                      </td>
                      <td className="px-5 py-3 font-medium">{row.customer_name}</td>
                      <td className="px-5 py-3">{row.assigned_to_name}</td>
                      <td className="px-5 py-3">
                        <Badge variant="outline">
                          {row.method === 'ROUND_ROBIN' ? 'Round robin' : 'Manual'}
                        </Badge>
                      </td>
                      <td className="max-w-80 truncate px-5 py-3 text-muted-foreground">
                        {row.reason ?? '—'}
                      </td>
                    </tr>
                  ))}
                  {!query.data.recent_assignments.length && (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                        No assignment history is visible yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
