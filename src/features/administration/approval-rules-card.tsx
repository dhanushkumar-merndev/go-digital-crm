'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { EmptyState, ErrorState } from '@/components/shared/page-states';
import { SectionCard } from '@/components/shared/section-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime, formatPercent } from '@/lib/format';
import {
  approvalRuleErrorMessage,
  approvalRulesKey,
  fetchApprovalRules,
  saveApprovalRule,
  type ApprovalRule,
  type ApprovalRules,
} from './approval-rules-api';

const ORGANIZATION_SCOPE = 'organization';

type Editing = { rule: ApprovalRule | null };

/**
 * Quotation discount approval limits (PRD 54.6 §48-49). A quotation whose
 * discount is above the limit for its branch goes to an approver; the branch
 * rule wins over the organization rule, and with neither the CRM keeps its
 * original 10%. Rules are switched off rather than deleted, and every save is
 * audited server-side.
 */
export function ApprovalRulesCard() {
  const session = useWorkspaceSession();
  const queryKey = [...approvalRulesKey, ...workspaceQueryScope(session)];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchApprovalRules(signal),
    staleTime: 60_000,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const data = query.data;
  const organizationRule = data?.rules.find((rule) => rule.branch_id === null);
  const openBranches =
    data?.branches.filter((branch) => !data.rules.some((rule) => rule.branch_id === branch.id)) ??
    [];
  const canAdd = Boolean(data?.can_manage && (!organizationRule || openBranches.length));

  return (
    <SectionCard
      title="Approval rules"
      description="Quotation discounts above these limits need an approver before they can be sent."
      flush
      contentClassName="overflow-x-auto"
      action={
        canAdd ? (
          <Button size="sm" onClick={() => setEditing({ rule: null })}>
            <Plus className="size-4" /> Add rule
          </Button>
        ) : undefined
      }
    >
      {query.isPending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : query.isError || !data ? (
        <ErrorState
          className="border-0"
          title="Approval rules are unavailable"
          description="They need an organization-wide Client Admin or Business Owner session."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Applies to</TableHead>
              <TableHead>Approval needed above</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last changed</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!organizationRule ? (
              <TableRow>
                <TableCell className="font-medium">All branches</TableCell>
                <TableCell>{formatPercent(data.default_percent)} discount</TableCell>
                <TableCell>
                  <StatusBadge value="Default" />
                </TableCell>
                <TableCell className="text-muted-foreground">CRM default</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  Add a rule to change it
                </TableCell>
              </TableRow>
            ) : null}
            {data.rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-medium">
                  {rule.branch_id ? (rule.branch_name ?? 'Branch') : 'All branches'}
                </TableCell>
                <TableCell>{formatPercent(rule.max_discount_percent)} discount</TableCell>
                <TableCell>
                  <StatusBadge value={rule.active ? 'Active' : 'Inactive'} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(rule.updated_at)}
                  {rule.updated_by_name ? ` · ${rule.updated_by_name}` : ''}
                </TableCell>
                <TableCell className="text-right">
                  {data.can_manage ? (
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ rule })}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {!data.rules.length && !data.can_manage ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState bare title="No custom approval rules yet" />
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
      {editing && data ? (
        <ApprovalRuleDialog
          key={editing.rule?.id ?? 'new'}
          rule={editing.rule}
          data={data}
          organizationRuleExists={Boolean(organizationRule)}
          openBranches={openBranches}
          onClose={() => setEditing(null)}
          queryKey={queryKey}
        />
      ) : null}
    </SectionCard>
  );
}

function ApprovalRuleDialog({
  rule,
  data,
  organizationRuleExists,
  openBranches,
  onClose,
  queryKey,
}: {
  rule: ApprovalRule | null;
  data: ApprovalRules;
  organizationRuleExists: boolean;
  openBranches: ApprovalRules['branches'];
  onClose: () => void;
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<string>(
    rule
      ? (rule.branch_id ?? ORGANIZATION_SCOPE)
      : organizationRuleExists
        ? (openBranches[0]?.id ?? ORGANIZATION_SCOPE)
        : ORGANIZATION_SCOPE,
  );
  const [percent, setPercent] = useState(
    String(rule?.max_discount_percent ?? data.default_percent),
  );
  const [active, setActive] = useState(rule?.active ?? true);
  const [requestId] = useState(() => crypto.randomUUID());
  const value = Number(percent);
  const valid = percent.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100;
  const save = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      saveApprovalRule({
        ruleId: rule?.id ?? null,
        expectedVersion: rule?.version ?? null,
        branchId: scope === ORGANIZATION_SCOPE ? null : scope,
        maxDiscountPercent: value,
        active,
        requestId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      toast.add({
        type: 'success',
        title: 'Approval rule saved',
        description: 'New quotations use this limit from now on.',
      });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit approval rule' : 'Add approval rule'}</DialogTitle>
          <DialogDescription>
            A quotation needs approval when its discount is above this share of the price.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="approval-rule-scope">Applies to</Label>
            <Select value={scope} onValueChange={setScope} disabled={Boolean(rule)}>
              <SelectTrigger id="approval-rule-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!organizationRuleExists || rule?.branch_id === null ? (
                  <SelectItem value={ORGANIZATION_SCOPE}>All branches</SelectItem>
                ) : null}
                {(rule?.branch_id
                  ? data.branches.filter((branch) => branch.id === rule.branch_id)
                  : openBranches
                ).map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A branch rule overrides the all-branches rule for that branch.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="approval-rule-percent">Approval needed above (% discount)</Label>
            <Input
              id="approval-rule-percent"
              inputMode="decimal"
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
              aria-invalid={!valid}
            />
            {!valid ? (
              <p className="text-xs text-destructive">Enter a percentage from 0 to 100.</p>
            ) : null}
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Rule is on</p>
              <p className="text-xs text-muted-foreground">
                Switched off, the branch falls back to the all-branches limit.
              </p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} aria-label="Rule is on" />
          </div>
          {save.isError ? (
            <p className="text-sm text-destructive">{approvalRuleErrorMessage(save.error)}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
