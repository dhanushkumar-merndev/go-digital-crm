'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import {
  fetchOrganizationSeatLimits,
  saveOrganizationSeatLimits,
  seatLimitsKey,
  type OrganizationSeatLimitRole,
  type OrganizationSeatLimits,
  type SeatLimitChange,
} from './seat-limits-api';

const groups = [
  ['ADMINISTRATION', 'Administration'],
  ['SALES', 'Sales'],
  ['DEPARTMENTS', 'Departments'],
] as const;

/** Blank is unlimited; anything else must be a whole number in range. */
function parseLimit(value: string, minimum: number) {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true as const, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false as const };
  const parsed = Number(trimmed);
  return parsed >= minimum && parsed <= 100_000
    ? { ok: true as const, value: parsed }
    : { ok: false as const };
}

const shown = (value: number | null) => (value === null ? '' : String(value));

/**
 * Super Admin's per-dealership caps: how many branches it may run and how many
 * people may hold each role, per branch or across the dealership.
 */
export function SeatLimitsCard({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const query = useQuery({
    queryKey: seatLimitsKey(organizationId),
    queryFn: ({ signal }) => fetchOrganizationSeatLimits(organizationId, signal),
    staleTime: 60_000,
  });

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Branch &amp; user limits</CardTitle>
        <CardDescription>
          How many branches this dealership can run and how many people may hold each role. Blank
          means unlimited. Limits refuse new invites, role changes and new branches; nobody already
          in a role loses access.
        </CardDescription>
      </CardHeader>
      {query.isPending ? (
        <CardContent className="space-y-2 p-5">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </CardContent>
      ) : query.isError ? (
        <CardContent className="p-8 text-center">
          <TriangleAlert className="mx-auto size-5 text-destructive" />
          <p className="mt-2 text-sm font-semibold">Limits could not be loaded</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </CardContent>
      ) : (
        <SeatLimitsForm
          // A fresh form for each saved version, so the inputs never show a stale draft.
          key={JSON.stringify([
            query.data.max_branches,
            query.data.roles.map((role) => role.max_users),
          ])}
          organizationId={organizationId}
          organizationName={organizationName}
          data={query.data}
        />
      )}
    </Card>
  );
}

function SeatLimitsForm({
  organizationId,
  organizationName,
  data,
}: {
  organizationId: string;
  organizationName: string;
  data: OrganizationSeatLimits;
}) {
  const queryClient = useQueryClient();
  const [branches, setBranches] = useState(shown(data.max_branches));
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.roles.map((role) => [role.role_key, shown(role.max_users)])),
  );
  // Roles sent back to the platform default, until saved.
  const [resetToDefault, setResetToDefault] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);

  const branchLimit = parseLimit(branches, 1);
  const parsed = data.roles.map((role) => ({
    role,
    parsed: parseLimit(limits[role.role_key] ?? '', 0),
  }));
  const invalid = !branchLimit.ok || parsed.some((row) => !row.parsed.ok);
  const changes = parsed.flatMap(({ role, parsed: next }): SeatLimitChange[] => {
    if (!next.ok) return [];
    if (resetToDefault.has(role.role_key))
      return role.overridden ? [{ role_key: role.role_key, use_default: true as const }] : [];
    return next.value === role.max_users
      ? []
      : [{ role_key: role.role_key, max_users: next.value }];
  });
  const branchChanged = branchLimit.ok && branchLimit.value !== data.max_branches;
  const dirty = branchChanged || changes.length > 0;

  const mutation = useMutation({
    mutationFn: () =>
      saveOrganizationSeatLimits({
        organizationId,
        maxBranches: branchLimit.ok ? branchLimit.value : data.max_branches,
        limits: changes,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(seatLimitsKey(organizationId), saved);
      setConfirming(false);
      toast.add({ type: 'success', title: 'Limits saved', description: organizationName });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Limits were not saved',
        description: 'Check your Super Admin MFA session and the values, then retry.',
      }),
  });

  const setRole = (role: OrganizationSeatLimitRole, value: string) => {
    setLimits((current) => ({ ...current, [role.role_key]: value }));
    setResetToDefault((current) => {
      const next = new Set(current);
      next.delete(role.role_key);
      return next;
    });
  };
  const restoreDefault = (role: OrganizationSeatLimitRole) => {
    setLimits((current) => ({ ...current, [role.role_key]: shown(role.default_max_users) }));
    setResetToDefault((current) => new Set(current).add(role.role_key));
  };

  return (
    <CardContent className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border bg-muted/20 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Branches (showrooms)</p>
          <p className="text-xs text-muted-foreground">
            {data.active_branches} active
            {data.max_branches !== null ? ` of ${data.max_branches} allowed` : ', no limit'}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Limit
          <Input
            value={branches}
            onChange={(event) => setBranches(event.target.value)}
            inputMode="numeric"
            placeholder="Unlimited"
            aria-invalid={!branchLimit.ok}
            aria-label="Branch limit"
            className="h-8 w-28 text-right"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Counted per</TableHead>
              <TableHead className="text-right">Default</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">In use</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map(([group, label]) => {
              const rows = parsed.filter((row) => row.role.role_group === group);
              if (rows.length === 0) return null;
              return [
                <TableRow key={group} className="bg-muted/30 hover:bg-muted/30">
                  <TableCell
                    colSpan={6}
                    className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {label}
                  </TableCell>
                </TableRow>,
                ...rows.map(({ role, parsed: next }) => (
                  <TableRow key={role.role_key}>
                    <TableCell className="font-medium">{role.role_name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {role.limit_scope === 'BRANCH' ? 'Each branch' : 'Whole dealership'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {role.default_max_users ?? 'Unlimited'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        value={limits[role.role_key] ?? ''}
                        onChange={(event) => setRole(role, event.target.value)}
                        inputMode="numeric"
                        placeholder="Unlimited"
                        aria-invalid={!next.ok}
                        aria-label={`${role.role_name} limit`}
                        className="ml-auto h-8 w-24 text-right"
                      />
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      <span className="font-semibold">{role.in_use}</span>
                      {role.limit_scope === 'BRANCH' && role.busiest_branch ? (
                        <span className="block text-muted-foreground">
                          most in {role.busiest_branch}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {role.over_limit ? (
                        <Badge variant="destructive" className="mr-2">
                          Over limit
                        </Badge>
                      ) : null}
                      {role.overridden && !resetToDefault.has(role.role_key) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => restoreDefault(role)}
                        >
                          <RotateCcw className="size-3" /> Default
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )),
              ];
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {invalid
            ? 'Use whole numbers (branches at least 1), or leave blank for unlimited.'
            : '"In use" is the dealership total, or the busiest branch for per-branch roles.'}
        </p>
        <Button disabled={!dirty || invalid} onClick={() => setConfirming(true)}>
          Save limits
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => !mutation.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save limits for {organizationName}?</DialogTitle>
            <DialogDescription>
              New invites, role changes, re-activations and new branches beyond these limits will be
              refused. People already in a role keep their access, even where a branch is now over
              its limit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? 'Saving…' : 'Save limits'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  );
}
