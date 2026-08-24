'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, CheckCircle2, Coins, Plus, ShieldCheck } from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SubscriptionPlanSkeleton } from '@/components/skeletons';
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
import { toast } from '@/components/ui/toast';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  fetchSubscriptionPlanWorkspace,
  saveSubscriptionPlan,
  type SubscriptionPlan,
  type SubscriptionPlanWorkspace,
} from './subscription-plan-workspace-api';

function requestId() {
  return globalThis.crypto.randomUUID();
}

function PlanDialog({
  workspace,
  plan,
  onClose,
}: {
  workspace: SubscriptionPlanWorkspace;
  plan: SubscriptionPlan | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(plan?.name ?? '');
  const [active, setActive] = useState(plan?.active ?? true);
  const [moduleIds, setModuleIds] = useState<string[]>(
    plan?.modules.map((module) => module.id) ?? [],
  );
  const [prevPlan, setPrevPlan] = useState(plan);
  if (prevPlan !== plan) {
    setPrevPlan(plan);
    setName(plan?.name ?? '');
    setActive(plan?.active ?? true);
    setModuleIds(plan?.modules.map((module) => module.id) ?? []);
  }
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: saveSubscriptionPlan,
    onSuccess: async () => {
      toast.add({
        type: 'success',
        title: 'Plan saved',
        description: 'The plan-feature matrix was audited.',
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-subscription-plans'] });
      onClose();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Plan not saved',
        description: 'Check your Super Admin MFA session and retry.',
      }),
  });
  const toggleModule = (moduleId: string) =>
    setModuleIds((current) =>
      current.includes(moduleId) ? current.filter((id) => id !== moduleId) : [...current, moduleId],
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{plan ? 'Edit subscription plan' : 'Create subscription plan'}</DialogTitle>
          <DialogDescription>
            Configure the real plan-to-module matrix. Pricing and tenant subscription terms are
            managed outside this schema.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              planId: plan?.id ?? null,
              name,
              active,
              moduleIds,
              requestId: requestId(),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Plan name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={120}
              required
            />
          </label>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Plan is active</p>
              <p className="text-xs text-muted-foreground">
                Inactive plans are retained and cannot be selected for new configuration.
              </p>
            </div>
            <Button
              type="button"
              variant={active ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActive((value) => !value)}
            >
              {active ? 'Active' : 'Inactive'}
            </Button>
          </div>
          <div>
            <p className="text-sm font-medium">Included modules</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Select only modules available in the platform catalog.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {workspace.available_modules.map((module) => {
                const selected = moduleIds.includes(module.id);
                return (
                  <Button
                    key={module.id}
                    type="button"
                    variant={selected ? 'secondary' : 'outline'}
                    disabled={!module.active && !selected}
                    className="h-auto justify-start whitespace-normal p-3 text-left"
                    onClick={() => toggleModule(module.id)}
                  >
                    <span>
                      <span className="block text-sm">{module.name}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {module.module_key}
                        {module.active ? '' : ' · disabled catalog module'}
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save plan'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SubscriptionPlanWorkspace({ spec }: { spec: PageSpec }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SubscriptionPlan | null | undefined>(undefined);
  const query = useQuery({
    queryKey: ['platform-subscription-plans'],
    queryFn: ({ signal }) => fetchSubscriptionPlanWorkspace(signal),
    staleTime: 60_000,
  });
  const workspace = query.data;
  const toggle = useMutation({
    mutationFn: (plan: SubscriptionPlan) =>
      saveSubscriptionPlan({
        planId: plan.id,
        name: plan.name,
        active: !plan.active,
        moduleIds: plan.modules.map((module) => module.id),
        requestId: requestId(),
      }),
    onSuccess: async () => {
      toast.add({
        type: 'success',
        title: 'Plan availability updated',
        description: 'The change was recorded in the platform audit log.',
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-subscription-plans'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Plan update failed',
        description: 'Please retry after confirming your MFA session.',
      }),
  });
  if (query.isPending) return <SubscriptionPlanSkeleton />;
  if (query.isError || !workspace)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Subscription plans are unavailable. Confirm Super Admin MFA access and deploy the plan
          workspace migration.
        </CardContent>
      </Card>
    );
  const metrics: Metric[] = [
    { label: 'Total plans', value: workspace.kpis.total_plans.toLocaleString(), icon: Coins },
    {
      label: 'Active plans',
      value: workspace.kpis.active_plans.toLocaleString(),
      icon: CheckCircle2,
    },
    {
      label: 'Plan-module assignments',
      value: workspace.kpis.module_assignments.toLocaleString(),
      icon: Blocks,
    },
    {
      label: 'Active catalog modules',
      value: workspace.kpis.active_modules.toLocaleString(),
      icon: ShieldCheck,
    },
  ];
  const moduleRows = workspace.available_modules.filter((module) =>
    workspace.plans.some((plan) => plan.modules.some((candidate) => candidate.id === module.id)),
  );
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Platform › Plans</div>
          <h1 className="text-2xl font-bold tracking-tight text-[#17233d]">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the platform plan-feature matrix. This screen intentionally shows no fabricated
            pricing or subscription counts.
          </p>
        </div>
        <Button onClick={() => setEditing(null)}>
          <Plus className="size-4" /> Create plan
        </Button>
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <div className="grid gap-4 xl:grid-cols-4">
        {workspace.plans.map((plan) => (
          <Card key={plan.id} className="shadow-none">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">{plan.name}</CardTitle>
                <Badge variant={plan.active ? 'success' : 'outline'}>
                  {plan.active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <CardDescription>{plan.modules.length} included modules</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {plan.modules.slice(0, 6).map((module) => (
                  <Badge key={module.id} variant="secondary">
                    {module.name}
                  </Badge>
                ))}
                {plan.modules.length > 6 ? (
                  <Badge variant="outline">+{plan.modules.length - 6} more</Badge>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setEditing(plan)}
                >
                  Edit plan
                </Button>
                <Button
                  variant={plan.active ? 'outline' : 'default'}
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(plan)}
                >
                  {plan.active ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Feature comparison</CardTitle>
          <CardDescription>
            Only stored plan-module assignments are shown. Per-module limits are currently empty
            until configured by a supported limits workflow.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-y bg-muted/30">
              <tr>
                <th className="p-3 text-left font-medium">Feature</th>
                {workspace.plans.map((plan) => (
                  <th key={plan.id} className="p-3 text-center font-medium">
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {moduleRows.map((module) => (
                <tr key={module.id} className="border-b">
                  <td className="p-3">
                    <p className="font-medium">{module.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{module.module_key}</p>
                  </td>
                  {workspace.plans.map((plan) => (
                    <td key={plan.id} className="p-3 text-center">
                      {plan.modules.some((candidate) => candidate.id === module.id) ? (
                        <Badge variant="success">Included</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {!moduleRows.length ? (
                <tr>
                  <td
                    colSpan={workspace.plans.length + 1}
                    className="p-10 text-center text-sm text-muted-foreground"
                  >
                    No module assignments have been configured.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {editing !== undefined ? (
        <PlanDialog workspace={workspace} plan={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </div>
  );
}
