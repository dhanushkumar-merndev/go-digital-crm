'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarDays, CarFront, Pencil, Target, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { EChart } from '@/components/charts/e-chart';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { TenantTargetConfigurationSkeleton } from '@/components/skeletons';
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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  fetchTenantTargetConfiguration,
  saveBranchTargetConfiguration,
  type BranchTarget,
} from './tenant-target-configuration-api';

function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function currency(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
    notation: value >= 10_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function attainment(actual: number, target: number) {
  return target > 0 ? (actual / target) * 100 : null;
}

export function TenantTargetConfigurationWorkspace({
  spec,
  readOnly = false,
}: {
  spec: PageSpec;
  readOnly?: boolean;
}) {
  const session = useWorkspaceSession();
  const [month, setMonth] = useState(currentMonth);
  const [selected, setSelected] = useState<BranchTarget | null>(null);
  const [salesTarget, setSalesTarget] = useState('0');
  const [bookingTarget, setBookingTarget] = useState('0');
  const [driveTarget, setDriveTarget] = useState('0');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['tenant-target-configuration', ...workspaceQueryScope(session), month],
    queryFn: ({ signal }) => fetchTenantTargetConfiguration(month, signal),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('TARGET_BRANCH_REQUIRED');
      return saveBranchTargetConfiguration({
        branchId: selected.id,
        month,
        salesTarget: Number(salesTarget),
        bookingTarget: Number(bookingTarget),
        driveTarget: Number(driveTarget),
        requestId: crypto.randomUUID(),
      });
    },
    onSuccess: async () => {
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ['tenant-target-configuration'] });
      toast.add({
        type: 'success',
        title: 'Branch targets saved',
        description: 'Monthly targets were updated and recorded in the audit trail.',
      });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Targets were not saved',
        description: 'Check the values and your Client Admin access, then try again.',
      }),
  });
  const edit = (branch: BranchTarget) => {
    setSelected(branch);
    setSalesTarget(String(branch.sales_target));
    setBookingTarget(String(branch.booking_target));
    setDriveTarget(String(branch.drive_target));
  };

  if (query.isPending) return <TenantTargetConfigurationSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <TriangleAlert className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 font-semibold">Target configuration is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires an MFA-assured, organization-wide Business Owner or Client Admin
            session.
          </p>
        </CardContent>
      </Card>
    );

  const data = query.data;
  const salesProgress = attainment(data.kpis.sales_value, data.kpis.sales_target);
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">
            {readOnly
              ? 'Business Owner › Targets & performance'
              : 'Administration › Target configuration'}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {readOnly
              ? 'View monthly branch targets and current outcomes. Target configuration remains with Client Admin.'
              : 'Set monthly branch targets. Team and individual targets remain separately managed so they are never overwritten here.'}
          </p>
        </div>
        <Input
          aria-label="Target month"
          className="w-44"
          max="2030-12"
          min="2025-01"
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value || currentMonth())}
        />
      </div>
      <KpiGrid
        className="xl:grid-cols-4"
        metrics={[
          {
            label: 'Active branches',
            value: data.kpis.branch_count.toLocaleString(),
            helper: `${data.kpis.configured_branches} configured`,
            icon: Target,
            tone: 'bg-blue-50 text-blue-600',
          },
          {
            label: 'Revenue target',
            value: data.kpis.sales_target ? currency(data.kpis.sales_target) : 'Not configured',
            helper: 'Combined branch target',
            icon: BarChart3,
            tone: 'bg-violet-50 text-violet-600',
          },
          {
            label: 'Booked sales',
            value: currency(data.kpis.sales_value),
            helper:
              salesProgress === null
                ? 'No revenue target configured'
                : `${salesProgress.toFixed(1)}% attained`,
            icon: CarFront,
            tone: 'bg-emerald-50 text-emerald-600',
          },
          {
            label: 'Approval policy',
            value: 'Workflow based',
            helper: 'Module approvals stay scoped',
            icon: CalendarDays,
            tone: 'bg-orange-50 text-orange-600',
          },
        ]}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Revenue target by branch</CardTitle>
            <CardDescription>Configured revenue target against live booked sales.</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart
              kind="bar"
              data={data.branches.map((branch) => ({
                name: branch.name,
                value: branch.sales_value,
                secondary: branch.sales_target,
              }))}
              seriesNames={['Booked sales', 'Target']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Approval-rule boundaries</CardTitle>
            <CardDescription>
              There is no unsafe tenant-wide override for operational approvals.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Quotation, booking and operational approvals use their module-specific policy and the
              authorized approver&apos;s scope.
            </p>
            <p>
              Branch targets configured below are audited configuration records; they do not approve
              customer-facing transactions.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {readOnly ? 'Branch target performance' : 'Branch target configuration'}
          </CardTitle>
          <CardDescription>
            {readOnly
              ? 'Current-month outcomes are compared with each configured branch target.'
              : 'Current-month outcomes are shown only for context; editing changes the selected branch’s monthly targets.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Revenue target</TableHead>
                <TableHead className="text-right">Booked sales</TableHead>
                <TableHead>Attainment</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Test drives</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.branches.map((branch) => {
                const progress = attainment(branch.sales_value, branch.sales_target);
                return (
                  <TableRow key={branch.id}>
                    <TableCell className="font-medium">{branch.name}</TableCell>
                    <TableCell className="text-right">
                      {branch.sales_target ? currency(branch.sales_target) : '—'}
                    </TableCell>
                    <TableCell className="text-right">{currency(branch.sales_value)}</TableCell>
                    <TableCell>
                      <Badge variant={progress !== null && progress >= 100 ? 'success' : 'outline'}>
                        {progress === null ? 'No target' : `${progress.toFixed(1)}%`}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {branch.bookings}
                      {branch.booking_target ? ` / ${branch.booking_target}` : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      {branch.test_drives}
                      {branch.drive_target ? ` / ${branch.drive_target}` : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      {!readOnly ? (
                        <Button size="sm" variant="outline" onClick={() => edit(branch)}>
                          <Pencil className="size-3.5" /> Edit targets
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!data.branches.length ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No active branches are available.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {!readOnly ? (
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => !open && !save.isPending && setSelected(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set branch targets</DialogTitle>
              <DialogDescription>
                {selected?.name} · {month}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="sales-target">Revenue target (₹)</Label>
                <Input
                  id="sales-target"
                  min="0"
                  step="1"
                  type="number"
                  value={salesTarget}
                  onChange={(event) => setSalesTarget(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="booking-target">Booking target</Label>
                <Input
                  id="booking-target"
                  min="0"
                  step="1"
                  type="number"
                  value={bookingTarget}
                  onChange={(event) => setBookingTarget(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="drive-target">Test-drive target</Label>
                <Input
                  id="drive-target"
                  min="0"
                  step="1"
                  type="number"
                  value={driveTarget}
                  onChange={(event) => setDriveTarget(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={save.isPending} onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  save.isPending ||
                  !Number.isFinite(Number(salesTarget)) ||
                  !Number.isFinite(Number(bookingTarget)) ||
                  !Number.isFinite(Number(driveTarget))
                }
                onClick={() => save.mutate()}
              >
                Save targets
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
