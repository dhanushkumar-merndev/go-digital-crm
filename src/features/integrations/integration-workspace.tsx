'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  Cable,
  ChevronLeft,
  ChevronRight,
  Link2,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { Metric, PageSpec } from '@/lib/domain';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  connectWhatsApp,
  fetchIntegrationOptions,
  fetchIntegrationWorkspace,
  fetchIntegrationWorkspacePermissions,
  fetchProviderAssets,
  saveProviderAssetMappings,
  startOAuthConnection,
  testIntegrationConnection,
  type IntegrationOptions,
  type IntegrationProviderKey,
  type IntegrationRecord,
  type IntegrationScopeMode,
} from './integration-workspace-api';
import {
  integrationStatusValues,
  isTrustedProviderAuthorizationUrl,
  parseIntegrationQuery,
  toIntegrationQueryString,
  type IntegrationQuery,
  type IntegrationStatusFilter,
} from './integration-workspace-query';

const providerOptions: Array<{ value: IntegrationProviderKey; label: string }> = [
  { value: 'meta', label: 'Meta / Facebook / Instagram' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'google_business_profile', label: 'Google Business Profile' },
  { value: 'whatsapp_cloud', label: 'WhatsApp Business Platform' },
];

const statusLabels: Record<IntegrationStatusFilter, string> = {
  all: 'All connections',
  connected: 'Connected',
  attention: 'Needs attention',
  authorizing: 'Authorizing',
};

const scopeLabels: Record<IntegrationScopeMode, string> = {
  ONE_BRANCH: 'One branch',
  SELECTED_BRANCHES: 'Selected branches',
  ALL_BRANCHES: 'All branches',
};

function providerLabel(value: string) {
  return providerOptions.find((provider) => provider.value === value)?.label ?? value;
}

function formatDate(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function maskIdentifier(value: string | null) {
  if (!value) return 'Account pending';
  if (value.length < 9) return 'Configured';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function toMetrics(kpis: Awaited<ReturnType<typeof fetchIntegrationWorkspace>>['kpis']): Metric[] {
  return [
    { label: 'Connected', value: kpis.connected.toLocaleString() },
    { label: 'Healthy', value: kpis.healthy.toLocaleString(), helper: 'No active error' },
    {
      label: 'Needs attention',
      value: kpis.attention.toLocaleString(),
      helper: 'Reconnect or review',
      trend: kpis.attention ? 'down' : 'neutral',
    },
    { label: 'Events today', value: kpis.events_today.toLocaleString() },
  ];
}

function BranchScopeFields({
  options,
  scopeMode,
  selectedBranchIds,
  onScopeModeChange,
  onSelectedBranchIdsChange,
}: {
  options: IntegrationOptions;
  scopeMode: IntegrationScopeMode;
  selectedBranchIds: string[];
  onScopeModeChange: (value: IntegrationScopeMode) => void;
  onSelectedBranchIdsChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <label className="grid gap-1.5 text-sm font-medium">
        Connection scope
        <Select
          value={scopeMode}
          onValueChange={(value) => {
            const next = value as IntegrationScopeMode;
            onScopeModeChange(next);
            onSelectedBranchIdsChange(
              next === 'ALL_BRANCHES'
                ? []
                : next === 'ONE_BRANCH'
                  ? selectedBranchIds.slice(0, 1)
                  : selectedBranchIds,
            );
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(scopeLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {scopeMode !== 'ALL_BRANCHES' && (
        <div>
          <p className="text-sm font-medium">
            {scopeMode === 'ONE_BRANCH' ? 'Select one branch' : 'Select branches'}
          </p>
          <div className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-y-auto">
            {options.branches.map((branch) => {
              const selected = selectedBranchIds.includes(branch.id);
              return (
                <Button
                  key={branch.id}
                  type="button"
                  size="sm"
                  variant={selected ? 'secondary' : 'outline'}
                  aria-pressed={selected}
                  onClick={() => {
                    if (scopeMode === 'ONE_BRANCH') {
                      onSelectedBranchIdsChange([branch.id]);
                      return;
                    }
                    onSelectedBranchIdsChange(
                      selected
                        ? selectedBranchIds.filter((id) => id !== branch.id)
                        : [...selectedBranchIds, branch.id],
                    );
                  }}
                >
                  {branch.name}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type ConnectRequest =
  | {
      kind: 'oauth';
      providerKey: Exclude<IntegrationProviderKey, 'whatsapp_cloud'>;
      displayName: string;
    }
  | {
      kind: 'whatsapp';
      displayName: string;
      phoneNumberId: string;
      whatsappBusinessAccountId: string;
      accessToken: string;
    };

function ProviderConnectionDialog({
  organizationId,
  role,
  existing,
  onClose,
  onConnected,
}: {
  organizationId: string;
  role: string;
  existing: IntegrationRecord | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const options = useQuery({
    queryKey: ['integration-options', organizationId],
    queryFn: fetchIntegrationOptions,
  });
  const [providerKey, setProviderKey] = useState<IntegrationProviderKey>(
    existing?.provider_key === 'whatsapp_cloud' ? 'whatsapp_cloud' : 'meta',
  );
  const [scopeMode, setScopeMode] = useState<IntegrationScopeMode>(
    existing?.scope_mode ?? 'ONE_BRANCH',
  );
  const [selectedBranchIds, setSelectedBranchIds] = useState(existing?.mapped_branch_ids ?? []);
  const [defaultInboundBranchId, setDefaultInboundBranchId] = useState(
    existing?.default_inbound_branch_id ?? '',
  );
  const [defaultTeamId, setDefaultTeamId] = useState(existing?.default_team_id ?? 'none');
  const inboundBranches =
    options.data?.branches.filter(
      (branch) => scopeMode === 'ALL_BRANCHES' || selectedBranchIds.includes(branch.id),
    ) ?? [];
  const selectedInboundBranch =
    inboundBranches.find((branch) => branch.id === defaultInboundBranchId)?.id ??
    inboundBranches[0]?.id ??
    '';
  const mutation = useMutation({
    mutationFn: async (request: ConnectRequest) => {
      if (request.kind === 'oauth') {
        const result = await startOAuthConnection({
          organizationId,
          providerKey: request.providerKey,
          displayName: request.displayName,
          scopeMode,
          branchIds: selectedBranchIds,
          redirectPath: `/${role}/integrations`,
        });
        if (!isTrustedProviderAuthorizationUrl(result.authorization_url))
          throw new Error('UNTRUSTED_PROVIDER_AUTHORIZATION_URL');
        return { authorizationUrl: result.authorization_url };
      }
      await connectWhatsApp({
        organizationId,
        connectionId: existing?.id,
        displayName: request.displayName,
        scopeMode,
        branchIds: selectedBranchIds,
        defaultInboundBranchId: selectedInboundBranch,
        defaultTeamId: defaultTeamId === 'none' ? undefined : defaultTeamId,
        phoneNumberId: request.phoneNumberId,
        whatsappBusinessAccountId: request.whatsappBusinessAccountId,
        accessToken: request.accessToken,
      });
      return { authorizationUrl: null };
    },
    onSuccess: ({ authorizationUrl }) => {
      if (authorizationUrl) {
        window.location.assign(authorizationUrl);
        return;
      }
      onConnected();
      onClose();
    },
  });
  const teams =
    options.data?.teams.filter((team) => team.branch_id === selectedInboundBranch) ?? [];
  const validScope =
    scopeMode === 'ALL_BRANCHES' ||
    (scopeMode === 'ONE_BRANCH' && selectedBranchIds.length === 1) ||
    (scopeMode === 'SELECTED_BRANCHES' && selectedBranchIds.length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Replace WhatsApp credential' : 'Connect provider'}</DialogTitle>
          <DialogDescription>
            Credentials are sent directly to the authenticated Edge boundary and are never stored in
            browser state or returned to the CRM.
          </DialogDescription>
        </DialogHeader>
        {options.isError ? (
          <Alert>
            <AlertTitle>Connection options unavailable</AlertTitle>
            <AlertDescription>Check your integration permission and branch scope.</AlertDescription>
          </Alert>
        ) : (
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const displayName = String(form.get('displayName') ?? '').trim();
              if (providerKey === 'whatsapp_cloud') {
                mutation.mutate({
                  kind: 'whatsapp',
                  displayName,
                  phoneNumberId: String(form.get('phoneNumberId') ?? '').trim(),
                  whatsappBusinessAccountId: String(
                    form.get('whatsappBusinessAccountId') ?? '',
                  ).trim(),
                  accessToken: String(form.get('accessToken') ?? '').trim(),
                });
                return;
              }
              mutation.mutate({ kind: 'oauth', providerKey, displayName });
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Provider
              <Select
                value={providerKey}
                disabled={Boolean(existing)}
                onValueChange={(value) => setProviderKey(value as IntegrationProviderKey)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((provider) => (
                    <SelectItem key={provider.value} value={provider.value}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Connection name
              <Input
                name="displayName"
                required
                minLength={2}
                maxLength={120}
                defaultValue={existing?.display_name}
                placeholder="Marketing account"
              />
            </label>
            {options.data && (
              <BranchScopeFields
                options={options.data}
                scopeMode={scopeMode}
                selectedBranchIds={selectedBranchIds}
                onScopeModeChange={setScopeMode}
                onSelectedBranchIdsChange={setSelectedBranchIds}
              />
            )}
            {providerKey === 'whatsapp_cloud' && options.data && (
              <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
                  Default inbound branch
                  <Select
                    value={selectedInboundBranch}
                    onValueChange={(value) => {
                      setDefaultInboundBranchId(value);
                      setDefaultTeamId('none');
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {inboundBranches.map((branch) => (
                        <SelectItem key={branch.id} value={branch.id}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
                  Default team <span className="font-normal text-muted-foreground">(optional)</span>
                  <Select value={defaultTeamId} onValueChange={setDefaultTeamId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No default team</SelectItem>
                      {teams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Phone number ID
                  <Input
                    name="phoneNumberId"
                    required
                    minLength={3}
                    maxLength={80}
                    defaultValue={existing?.external_account_id ?? ''}
                    autoComplete="off"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  WhatsApp Business Account ID
                  <Input
                    name="whatsappBusinessAccountId"
                    required
                    minLength={3}
                    maxLength={80}
                    autoComplete="off"
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
                  Access token
                  <Input
                    name="accessToken"
                    type="password"
                    required
                    minLength={20}
                    maxLength={4096}
                    autoComplete="new-password"
                  />
                </label>
              </div>
            )}
            {mutation.isError && (
              <Alert>
                <AlertTitle>Connection was not saved</AlertTitle>
                <AlertDescription>
                  Verify provider access, branch scope and server configuration, then retry.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  options.isPending ||
                  !options.data ||
                  !validScope ||
                  (providerKey === 'whatsapp_cloud' && !selectedInboundBranch)
                }
              >
                <Link2 className="size-4" />
                {mutation.isPending
                  ? 'Connecting…'
                  : providerKey === 'whatsapp_cloud'
                    ? 'Test and save'
                    : 'Continue with provider'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type AssetSelection = { branchId: string; teamId: string };

function ProviderAssetMappingDialog({
  organizationId,
  connection,
  onClose,
  onSaved,
}: {
  organizationId: string;
  connection: IntegrationRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const options = useQuery({
    queryKey: ['integration-options', organizationId],
    queryFn: fetchIntegrationOptions,
  });
  const [parentAssetId, setParentAssetId] = useState<string | undefined>();
  const assets = useQuery({
    queryKey: ['integration-provider-assets', organizationId, connection.id, parentAssetId],
    queryFn: () => fetchProviderAssets(organizationId, connection.id, parentAssetId),
  });
  const existingSelections = useMemo(() => {
    const next: Record<string, AssetSelection> = {};
    if (!assets.data) return next;
    for (const mapping of assets.data.selected_mappings) {
      const key = `${mapping.external_resource_type}:${mapping.external_resource_id}`;
      if (assets.data.assets.some((asset) => `${asset.type}:${asset.id}` === key))
        next[key] = { branchId: mapping.branch_id, teamId: mapping.team_id ?? 'none' };
    }
    return next;
  }, [assets.data]);
  const [selectionOverrides, setSelectionOverrides] = useState<
    Record<string, AssetSelection | null>
  >({});
  const selections = useMemo(() => {
    const next = { ...existingSelections };
    for (const [key, selection] of Object.entries(selectionOverrides)) {
      if (selection) next[key] = selection;
      else delete next[key];
    }
    return next;
  }, [existingSelections, selectionOverrides]);
  const save = useMutation({
    mutationFn: () =>
      saveProviderAssetMappings({
        organizationId,
        connectionId: connection.id,
        parentAssetId,
        mappings: (assets.data?.assets ?? []).flatMap((asset) => {
          const selected = selections[`${asset.type}:${asset.id}`];
          return selected?.branchId
            ? [
                {
                  asset_type: asset.type,
                  asset_id: asset.id,
                  branch_id: selected.branchId,
                  team_id: selected.teamId === 'none' ? null : selected.teamId,
                },
              ]
            : [];
        }),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const googleCustomers =
    assets.data?.assets.filter((asset) => asset.type === 'GOOGLE_ADS_CUSTOMER') ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Map provider assets</DialogTitle>
          <DialogDescription>
            Assign each external page, account, campaign, form or location to an authorized CRM
            branch and optional team.
          </DialogDescription>
        </DialogHeader>
        {connection.provider_key === 'google_ads' && googleCustomers.length > 0 && (
          <label className="mt-4 grid gap-1.5 text-sm font-medium">
            Google Ads account context
            <Select
              value={parentAssetId ?? 'none'}
              onValueChange={(value) => setParentAssetId(value === 'none' ? undefined : value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Accounts only</SelectItem>
                {googleCustomers.map((asset) => (
                  <SelectItem key={asset.id} value={asset.id}>
                    {asset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        {assets.isPending || options.isPending ? (
          <div className="mt-6 rounded-lg border p-8 text-center text-sm text-muted-foreground">
            Loading provider assets…
          </div>
        ) : assets.isError || options.isError || !assets.data || !options.data ? (
          <Alert className="mt-6">
            <AlertTitle>Provider assets unavailable</AlertTitle>
            <AlertDescription>
              Test or reconnect the provider, verify server credentials, and retry.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="mt-6 space-y-3">
            {assets.data.assets.length === 0 ? (
              <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
                This provider returned no accessible assets.
              </div>
            ) : (
              assets.data.assets.map((asset) => {
                const key = `${asset.type}:${asset.id}`;
                const selected = selections[key];
                const teams = selected
                  ? options.data.teams.filter((team) => team.branch_id === selected.branchId)
                  : [];
                return (
                  <div
                    key={key}
                    className="grid gap-3 rounded-lg border p-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_auto] lg:items-end"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{asset.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {asset.type.replaceAll('_', ' ')} · {maskIdentifier(asset.id)}
                      </p>
                    </div>
                    <label className="grid gap-1 text-xs font-medium">
                      Branch
                      <Select
                        value={selected?.branchId ?? 'none'}
                        onValueChange={(branchId) =>
                          setSelectionOverrides((current) => ({
                            ...current,
                            [key]: branchId === 'none' ? null : { branchId, teamId: 'none' },
                          }))
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not mapped</SelectItem>
                          {options.data.branches.map((branch) => (
                            <SelectItem key={branch.id} value={branch.id}>
                              {branch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="grid gap-1 text-xs font-medium">
                      Team
                      <Select
                        value={selected?.teamId ?? 'none'}
                        disabled={!selected}
                        onValueChange={(teamId) => {
                          if (!selected) return;
                          setSelectionOverrides((current) => ({
                            ...current,
                            [key]: { ...selected, teamId },
                          }));
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No default team</SelectItem>
                          {teams.map((team) => (
                            <SelectItem key={team.id} value={team.id}>
                              {team.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <StatusBadge value={selected ? 'Mapped' : 'Not mapped'} />
                  </div>
                );
              })
            )}
          </div>
        )}
        {save.isError && (
          <Alert className="mt-4">
            <AlertTitle>Mappings were not saved</AlertTitle>
            <AlertDescription>
              Refresh provider assets and verify that every branch is within your scope.
            </AlertDescription>
          </Alert>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !assets.data || !options.data}
          >
            <Settings2 className="size-4" />
            {save.isPending ? 'Saving…' : 'Save mappings'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationTable({
  records,
  total,
  query,
  isFetching,
  canManage,
  testingId,
  onQueryChange,
  onTest,
  onMap,
  onReplace,
}: {
  records: IntegrationRecord[];
  total: number;
  query: IntegrationQuery;
  isFetching: boolean;
  canManage: boolean;
  testingId: string | null;
  onQueryChange: (value: Partial<IntegrationQuery>) => void;
  onTest: (record: IntegrationRecord) => void;
  onMap: (record: IntegrationRecord) => void;
  onReplace: (record: IntegrationRecord) => void;
}) {
  const columns = useMemo<ColumnDef<IntegrationRecord>[]>(
    () => [
      {
        accessorKey: 'provider_key',
        header: 'Provider',
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{providerLabel(row.original.provider_key)}</p>
            <p className="text-xs text-muted-foreground">
              {maskIdentifier(row.original.external_account_id)}
            </p>
          </div>
        ),
      },
      { accessorKey: 'display_name', header: 'Connection' },
      {
        accessorKey: 'scope_mode',
        header: 'Branch scope',
        cell: ({ row }) => (
          <div>
            <p>{scopeLabels[row.original.scope_mode]}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.scope_mode === 'ALL_BRANCHES'
                ? 'Organization-wide'
                : `${row.original.mapped_branch_ids.length} mapped`}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'last_sync_at',
        header: 'Last sync',
        cell: ({ row }) => formatDate(row.original.last_sync_at),
      },
      {
        id: 'health',
        header: 'Health',
        cell: ({ row }) => (
          <StatusBadge value={row.original.last_error_code ? 'Needs attention' : 'Healthy'} />
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge value={row.original.status} />,
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          if (!canManage) return <span className="text-xs text-muted-foreground">View only</span>;
          const record = row.original;
          const oauth = ['meta', 'google_ads', 'google_business_profile'].includes(
            record.provider_key,
          );
          return (
            <div className="flex flex-wrap gap-2">
              {oauth && record.status === 'CONNECTED' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testingId === record.id}
                    onClick={() => onTest(record)}
                  >
                    <RefreshCw className="size-3.5" />
                    Test
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onMap(record)}>
                    <Settings2 className="size-3.5" />
                    Map assets
                  </Button>
                </>
              )}
              {record.provider_key === 'whatsapp_cloud' && (
                <Button size="sm" variant="outline" onClick={() => onReplace(record)}>
                  Replace credential
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [canManage, onMap, onReplace, onTest, testingId],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data: records, columns, getCoreRowModel: getCoreRowModel() });
  const pages = Math.max(1, Math.ceil(total / query.pageSize));

  return (
    <Card className="shadow-none">
      <CardHeader className="gap-4 border-b p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query.search}
              onChange={(event) => onQueryChange({ search: event.target.value, page: 1 })}
              className="pl-9"
              placeholder="Search this integration list"
              maxLength={80}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={query.status}
              onValueChange={(value) =>
                onQueryChange({ status: value as IntegrationStatusFilter, page: 1 })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {integrationStatusValues.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.sort}
              onValueChange={(value) =>
                onQueryChange({ sort: value as IntegrationQuery['sort'], page: 1 })
              }
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated:desc">Recently updated</SelectItem>
                <SelectItem value="updated:asc">Oldest updated</SelectItem>
                <SelectItem value="name:asc">Connection A–Z</SelectItem>
                <SelectItem value="provider:asc">Provider A–Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table className={isFetching ? 'opacity-60' : undefined}>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
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
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-28 text-center">
                    No provider connections match this view.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} connection{total === 1 ? '' : 's'}
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                onQueryChange({ pageSize: Number(value) as 25 | 50 | 100, page: 1 })
              }
            >
              <SelectTrigger className="h-8 w-[82px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {query.page} / {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              disabled={query.page <= 1}
              onClick={() => onQueryChange({ page: query.page - 1 })}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
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

export function IntegrationWorkspace({ spec, role }: { spec: PageSpec; role: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<IntegrationQuery>(() => parseIntegrationQuery(searchParams));
  const [connectOpen, setConnectOpen] = useState(false);
  const [replaceConnection, setReplaceConnection] = useState<IntegrationRecord | null>(null);
  const [mappingConnection, setMappingConnection] = useState<IntegrationRecord | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const permissions = useQuery({
    queryKey: ['integration-workspace-permissions'],
    queryFn: fetchIntegrationWorkspacePermissions,
  });
  useTenantRealtimeInvalidation(permissions.data?.organizationId, [
    { resource: 'integrations', queryKeys: [['integration-workspace']] },
  ]);
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = useMemo(
    () => ({ ...query, search: debouncedSearch }),
    [debouncedSearch, query],
  );
  const workspace = useQuery({
    queryKey: ['integration-workspace', permissions.data?.organizationId, requestQuery],
    queryFn: () => fetchIntegrationWorkspace(requestQuery),
    enabled: Boolean(permissions.data),
    placeholderData: keepPreviousData,
  });
  const testConnection = useMutation({
    mutationFn: (record: IntegrationRecord) =>
      testIntegrationConnection(record.organization_id, record.id),
    onSuccess: () => {
      setActionMessage('Connection test succeeded.');
      void queryClient.invalidateQueries({ queryKey: ['integration-workspace'] });
    },
  });
  const changeQuery = useCallback(
    (next: Partial<IntegrationQuery>) => {
      setQuery((current) => {
        const updated = { ...current, ...next };
        const queryString = toIntegrationQueryString(updated);
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
        return updated;
      });
    },
    [pathname, router],
  );
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['integration-workspace'] });
  }, [queryClient]);

  if (permissions.isPending || (workspace.isPending && permissions.data)) return <PageSkeleton />;
  if (permissions.isError || workspace.isError || !permissions.data || !workspace.data)
    return (
      <div className="space-y-6">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Card className="shadow-none">
          <CardContent className="p-8 text-center">
            <p className="font-semibold">Integrations are unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Confirm tenant access, the integration permission, and deployed provider migrations.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const callbackStatus = searchParams.get('integration');
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        {permissions.data.canManage && (
          <div className="shrink-0 sm:pt-7">
            <Button onClick={() => setConnectOpen(true)}>
              <Cable className="size-4" />
              Connect provider
            </Button>
          </div>
        )}
      </div>
      {callbackStatus === 'connected' && (
        <Alert>
          <AlertTitle>Provider connected</AlertTitle>
          <AlertDescription>
            Test the connection, then map its external assets to CRM branches and teams.
          </AlertDescription>
        </Alert>
      )}
      {callbackStatus === 'error' && (
        <Alert>
          <AlertTitle>Provider authorization failed</AlertTitle>
          <AlertDescription>
            The request was safely closed. Verify the provider console callback and reconnect.
          </AlertDescription>
        </Alert>
      )}
      {actionMessage && (
        <Alert>
          <AlertTitle>{actionMessage}</AlertTitle>
          <AlertDescription>The latest health state is being refreshed.</AlertDescription>
        </Alert>
      )}
      {testConnection.isError && (
        <Alert>
          <AlertTitle>Connection test failed</AlertTitle>
          <AlertDescription>Reconnect or replace the credential, then test again.</AlertDescription>
        </Alert>
      )}
      <KpiGrid metrics={toMetrics(workspace.data.kpis)} />
      <IntegrationTable
        records={workspace.data.records}
        total={workspace.data.total}
        query={query}
        isFetching={workspace.isFetching}
        canManage={permissions.data.canManage}
        testingId={testConnection.isPending ? (testConnection.variables?.id ?? null) : null}
        onQueryChange={changeQuery}
        onTest={(record) => {
          setActionMessage(null);
          testConnection.mutate(record);
        }}
        onMap={setMappingConnection}
        onReplace={setReplaceConnection}
      />
      {connectOpen && (
        <ProviderConnectionDialog
          organizationId={permissions.data.organizationId}
          role={role}
          existing={null}
          onClose={() => setConnectOpen(false)}
          onConnected={refresh}
        />
      )}
      {replaceConnection && (
        <ProviderConnectionDialog
          organizationId={permissions.data.organizationId}
          role={role}
          existing={replaceConnection}
          onClose={() => setReplaceConnection(null)}
          onConnected={refresh}
        />
      )}
      {mappingConnection && (
        <ProviderAssetMappingDialog
          organizationId={permissions.data.organizationId}
          connection={mappingConnection}
          onClose={() => setMappingConnection(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
