'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Send, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
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
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  bulkCampaignKey,
  bulkChannels,
  cancelBulkCampaign,
  createBulkCampaign,
  fetchBulkCampaigns,
  getBulkCampaignErrorMessage,
  type BulkAudienceFilter,
  type BulkChannel,
} from './bulk-campaign-api';
import { fetchMarketingAssetLibrary, marketingAssetLibraryKey } from './ai-image-creation-api';
import {
  customerDripTemplateOptionsKey,
  fetchCustomerDripTemplateOptions,
} from '@/features/customers/customer-drip-api';

const lifecycleChoices = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Lost',
] as const;
const temperatureChoices = ['HOT', 'WARM', 'COLD', 'DORMANT'] as const;

function CreateCampaignDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [channel, setChannel] = useState<BulkChannel>('EMAIL');
  const [lifecycle, setLifecycle] = useState('ALL');
  const [temperature, setTemperature] = useState('ALL');
  const [templateId, setTemplateId] = useState('');
  const [assetId, setAssetId] = useState('NONE');

  // Only approved templates can be offered: a blast is never inside a 24h
  // service window, so free text could not be delivered on any channel.
  const templates = useQuery({
    queryKey: customerDripTemplateOptionsKey,
    queryFn: ({ signal }) => fetchCustomerDripTemplateOptions(signal),
    staleTime: 300_000,
  });
  const assets = useQuery({
    queryKey: marketingAssetLibraryKey(1, '', ''),
    queryFn: () => fetchMarketingAssetLibrary({ page: 1, pageSize: 25, search: '', tag: '' }),
    staleTime: 300_000,
  });
  const create = useMutation({
    mutationFn: createBulkCampaign,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: result.replayed ? 'Campaign already created' : 'Campaign queued',
        description: `${result.recipient_count} recipient${result.recipient_count === 1 ? '' : 's'} resolved.`,
      });
      void client.invalidateQueries({ queryKey: ['bulk-campaign-workspace'] });
      onClose();
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Campaign was not created',
        description: getBulkCampaignErrorMessage(error),
      }),
  });

  const available = (templates.data ?? []).filter((option) => option.channel === channel);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New bulk campaign</DialogTitle>
          <DialogDescription>
            The audience is resolved and frozen now, so the recipient count you see is exactly who
            is sent to.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const audienceFilter: BulkAudienceFilter = {};
            if (lifecycle !== 'ALL') audienceFilter.lifecycle_status = [lifecycle];
            if (temperature !== 'ALL') audienceFilter.temperature = [temperature];
            const days = Number(form.get('created_within_days') ?? '');
            if (Number.isInteger(days) && days > 0) audienceFilter.created_within_days = days;
            create.mutate({
              name: String(form.get('name') ?? ''),
              channel,
              templateId,
              templateVariables: {},
              assetId: assetId === 'NONE' ? null : assetId,
              branchId: null,
              audienceFilter,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Campaign name
            <Input name="name" required minLength={3} maxLength={180} placeholder="Diwali offer" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Channel
            <Select
              value={channel}
              onValueChange={(value) => {
                setChannel(value as BulkChannel);
                setTemplateId('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bulkChannels.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item === 'WHATSAPP' ? 'WhatsApp' : item === 'SMS' ? 'SMS' : 'Email'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {channel === 'SMS' && (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>No SMS provider is connected</AlertTitle>
              <AlertDescription>
                SMS recipients will be queued and then fail. Use WhatsApp or email until an SMS
                provider is configured.
              </AlertDescription>
            </Alert>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Approved template
            {available.length ? (
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an approved template" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="rounded-md border border-dashed p-2 text-xs font-normal text-muted-foreground">
                No approved template for this channel. An administrator approves one under Templates
                before a blast can be sent.
              </span>
            )}
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Creative (optional)
            <Select value={assetId} onValueChange={setAssetId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">No image</SelectItem>
                {(assets.data?.records ?? []).map((asset) => (
                  <SelectItem key={asset.id} value={asset.id}>
                    {asset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Stage
              <Select value={lifecycle} onValueChange={setLifecycle}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Any stage</SelectItem>
                  {lifecycleChoices.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Temperature
              <Select value={temperature} onValueChange={setTemperature}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Any</SelectItem>
                  {temperatureChoices.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Lead age (days)
              <Input name="created_within_days" type="number" min={1} max={3650} placeholder="90" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={create.isPending || !templateId}>
              <Send /> {create.isPending ? 'Queueing…' : 'Create campaign'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BulkCampaignWorkspace({ spec }: { spec: PageSpec }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: bulkCampaignKey(page),
    queryFn: ({ signal }) => fetchBulkCampaigns(page, signal),
    placeholderData: keepPreviousData,
    // Progress moves as the dispatcher drains the queue.
    refetchInterval: 15_000,
  });
  const cancel = useMutation({
    mutationFn: cancelBulkCampaign,
    onSuccess: (cancelled) => {
      toast.add({
        type: 'success',
        title: 'Campaign cancelled',
        description: `${cancelled} queued recipient${cancelled === 1 ? '' : 's'} stopped. Sends already in flight are left to finish.`,
      });
      void client.invalidateQueries({ queryKey: ['bulk-campaign-workspace'] });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Campaign was not cancelled',
        description: getBulkCampaignErrorMessage(error),
      }),
  });

  if (workspace.isError)
    return (
      <div className="space-y-5">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert>
          <AlertTitle>Bulk campaigns are unavailable</AlertTitle>
          <AlertDescription>
            Confirm marketing automation access and deploy the bulk campaign migration.
          </AlertDescription>
        </Alert>
      </div>
    );
  const records = workspace.data?.records ?? [];
  const total = workspace.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Button onClick={() => setOpen(true)}>
          <Plus /> New campaign
        </Button>
      </div>
      <Card className="shadow-none">
        <CardHeader className="border-b p-4 text-sm text-muted-foreground">
          Sending runs in the background. A campaign completes once every recipient has been
          attempted.
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Pending</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Megaphone className="size-4 text-blue-600" />
                        {item.channel}
                      </span>
                    </TableCell>
                    <TableCell>{item.recipient_count}</TableCell>
                    <TableCell>{item.sent}</TableCell>
                    <TableCell className={item.failed ? 'text-destructive' : undefined}>
                      {item.failed}
                    </TableCell>
                    <TableCell>{item.pending}</TableCell>
                    <TableCell>
                      <StatusBadge value={item.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {['QUEUED', 'RUNNING'].includes(item.status) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(item.id)}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                    No bulk campaigns yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex items-center justify-between border-t p-3 text-sm text-muted-foreground">
          <span>{total} campaigns</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} / {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
      {open && <CreateCampaignDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
