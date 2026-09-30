'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNationalPhone } from '@/lib/phone';
import {
  createTelecmiAgentForUser,
  daysUntil,
  fetchTelecmiPlan,
  setTelecmiSeatLimit,
  telecmiPlanQueryKeyRoot,
  type TelecmiPlan,
} from './telecmi-agents-api';

const EXPIRY_WARNING_DAYS = 3;

const roleLabels: Record<string, string> = {
  telecaller_bdc: 'Telecaller',
  sales_consultant: 'Sales Consultant',
};

function formatMoney(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatExpiry(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function planWarnings(plan: TelecmiPlan) {
  const warnings: Array<{ title: string; detail: string }> = [];
  if (plan.expires_at) {
    const days = daysUntil(plan.expires_at);
    if (days < 0)
      warnings.push({
        title: 'TeleCMI plan has expired',
        detail: 'Calls from the CRM will fail until the plan is renewed in TeleCMI.',
      });
    else if (days <= EXPIRY_WARNING_DAYS)
      warnings.push({
        title:
          days === 0
            ? 'TeleCMI plan expires today'
            : `TeleCMI plan expires in ${days} day${days === 1 ? '' : 's'}`,
        detail: 'Renew it in the TeleCMI dashboard to keep calling from the CRM.',
      });
  }
  if (plan.balance !== null && plan.balance <= 0)
    warnings.push({
      title: 'No call balance',
      detail: 'TeleCMI reports a zero call balance. Top up before telecallers start calling.',
    });
  if (plan.seats_left === 0)
    warnings.push({
      title: 'No free agent seats',
      detail: 'New telecallers cannot get a TeleCMI agent until a seat is freed or added.',
    });
  return warnings;
}

/**
 * TeleCMI plan health for one dealership line: seats, balance and expiry from
 * TeleCMI, plus which telecallers and consultants can place a CRM call. Agent
 * creation and the seat count are Client Admin actions; the Edge Function and
 * the database both re-check that.
 */
export function TelecmiPlanCard({
  organizationId,
  connectionId,
}: {
  organizationId: string;
  connectionId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = [...telecmiPlanQueryKeyRoot, organizationId, connectionId];
  const plan = useQuery({
    queryKey,
    queryFn: () => fetchTelecmiPlan({ organizationId, connectionId }),
    staleTime: 60_000,
  });
  const [seatDraft, setSeatDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const saveSeats = useMutation({
    mutationFn: (seatLimit: number | null) =>
      setTelecmiSeatLimit({ organizationId, connectionId, seatLimit }),
    onSuccess: () => {
      setSeatDraft(null);
      setMessage('Seat count saved.');
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const createAgent = useMutation({
    mutationFn: (userId: string) =>
      createTelecmiAgentForUser({ organizationId, connectionId, userId }),
    onSuccess: (result) => {
      setMessage(
        result.status === 'CREATED'
          ? `TeleCMI agent created on extension ${result.extension}.`
          : 'Linked the TeleCMI agent that already uses this mobile.',
      );
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (plan.isPending)
    return (
      <section className="space-y-3 rounded-lg border p-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
      </section>
    );
  if (plan.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>TeleCMI plan unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {plan.error instanceof Error ? plan.error.message : 'The plan could not be loaded.'}
          <Button size="sm" variant="outline" onClick={() => void plan.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  const data = plan.data;
  const warnings = planWarnings(data);
  const seatsFull = data.seats_left === 0;
  const seatValue = seatDraft ?? (data.seat_limit === null ? '' : String(data.seat_limit));
  const parsedSeats = seatValue.trim() === '' ? null : Number(seatValue);
  const seatInputValid =
    parsedSeats === null ||
    (Number.isInteger(parsedSeats) && parsedSeats >= 1 && parsedSeats <= 1000);
  const expiryDays = data.expires_at ? daysUntil(data.expires_at) : null;
  const mutationError = createAgent.error ?? saveSeats.error;

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">TeleCMI plan</h3>
        <p className="text-sm text-muted-foreground">
          Seats, balance and expiry come from TeleCMI. TeleCMI does not report the plan&apos;s seat
          count, so enter it below.
        </p>
      </div>

      {data.provider_error ? (
        <Alert variant="destructive">
          <AlertTitle>TeleCMI did not answer</AlertTitle>
          <AlertDescription>{data.provider_error.message}</AlertDescription>
        </Alert>
      ) : null}
      {warnings.map((warning) => (
        <Alert key={warning.title} variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{warning.title}</AlertTitle>
          <AlertDescription>{warning.detail}</AlertDescription>
        </Alert>
      ))}

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat
          label="Agent seats"
          value={
            data.seats_used === null
              ? '—'
              : data.seat_limit === null
                ? `${data.seats_used} used`
                : `${data.seats_used} / ${data.seat_limit}`
          }
          detail={
            data.seats_left === null
              ? 'Enter the plan seat count to see seats left'
              : `${data.seats_left} left`
          }
        />
        <Stat label="Call balance" value={formatMoney(data.balance)} />
        <Stat
          label="SMS balance"
          value={data.sms_balance === null ? '—' : String(data.sms_balance)}
        />
        <Stat
          label="Plan expires"
          value={formatExpiry(data.expires_at)}
          detail={
            expiryDays === null
              ? undefined
              : expiryDays < 0
                ? 'Expired'
                : expiryDays === 0
                  ? 'Today'
                  : `In ${expiryDays} day${expiryDays === 1 ? '' : 's'}`
          }
        />
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (seatInputValid) saveSeats.mutate(parsedSeats);
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          Seats in the TeleCMI plan
          <Input
            className="w-32"
            inputMode="numeric"
            placeholder="e.g. 3"
            value={seatValue}
            onChange={(event) => setSeatDraft(event.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={seatDraft === null || !seatInputValid || saveSeats.isPending}
        >
          {saveSeats.isPending ? 'Saving…' : 'Save seats'}
        </Button>
      </form>

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {mutationError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {mutationError instanceof Error ? mutationError.message : 'The request failed.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h4 className="text-sm font-medium">Agents in TeleCMI</h4>
        {data.agents.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No agents reported by TeleCMI.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border text-sm">
            {data.agents.map((agent) => (
              <li key={agent.agent_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {agent.crm_user_name ?? agent.name ?? agent.agent_id}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Ext {agent.extension ?? '—'}
                    {agent.phone ? ` · ${formatNationalPhone(agent.phone)}` : ''}
                  </p>
                </div>
                <StatusBadge value={agent.linked ? 'Linked' : 'Not linked'} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-sm font-medium">Telecallers and consultants without an agent</h4>
        {data.users_without_agent.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Everyone this line covers can call from the CRM.
          </p>
        ) : (
          <ul className="mt-2 divide-y rounded-lg border text-sm">
            {data.users_without_agent.map((user) => {
              const pending = createAgent.isPending && createAgent.variables === user.user_id;
              // Linking an agent TeleCMI already has does not need a free seat.
              const blocked = !user.phone || (seatsFull && !user.telecmi_agent_exists);
              return (
                <li key={user.user_id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{user.full_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {roleLabels[user.role_key] ?? user.role_key}
                      {' · '}
                      {user.phone ? formatNationalPhone(user.phone) : 'No mobile on profile'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked || createAgent.isPending}
                    onClick={() => {
                      setMessage(null);
                      createAgent.mutate(user.user_id);
                    }}
                  >
                    <UserPlus className="size-3.5" />
                    {pending
                      ? 'Creating…'
                      : user.telecmi_agent_exists
                        ? 'Link agent'
                        : 'Create agent'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
