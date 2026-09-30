'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IndianRupee, LoaderCircle, Megaphone, Plus } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import type { MarketingCampaignRecord } from './marketing-api';
import {
  campaignPlatforms,
  campaignSources,
  campaignStatuses,
  getCampaignErrorMessage,
  recordMarketingCampaignMetrics,
  saveMarketingCampaign,
  type CampaignPlatform,
  type CampaignSource,
  type CampaignStatus,
} from './marketing-campaign-api';
import { marketingLabel } from './marketing-query';
import { fetchSocialPostDraftOptions } from './social-post-draft-api';

const workspaceKey = ['marketing-workspace'] as const;

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

/** Today in the dealership's timezone, as the RPC validates against it. */
function todayInKolkata() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function optionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The same branch list the social-post draft uses: the caller's authorized scope. */
function useCampaignScopeOptions() {
  return useQuery({
    queryKey: ['social-post-draft-options'],
    queryFn: ({ signal }) => fetchSocialPostDraftOptions(signal),
    staleTime: 5 * 60_000,
  });
}

export function CampaignFormDialog({
  campaign,
  open,
  onOpenChange,
}: {
  campaign: MarketingCampaignRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {/* Keyed so reopening for another campaign seeds a fresh form. */}
        {open ? (
          <CampaignForm
            key={campaign?.id ?? 'new'}
            campaign={campaign}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CampaignForm({
  campaign,
  onDone,
}: {
  campaign: MarketingCampaignRecord | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const scope = useCampaignScopeOptions();
  const [name, setName] = useState(campaign?.name ?? '');
  const [platform, setPlatform] = useState<CampaignPlatform>(
    (campaign?.platform as CampaignPlatform | undefined) ?? 'META',
  );
  const [source, setSource] = useState<CampaignSource>(
    (campaign?.canonical_source as CampaignSource | undefined) ?? 'Facebook',
  );
  const [status, setStatus] = useState<CampaignStatus>(
    (campaign?.status as CampaignStatus | undefined) ?? 'ACTIVE',
  );
  const [scopeValue, setScopeValue] = useState(
    campaign ? (campaign.branch_id ?? 'organization') : '',
  );
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(
    campaign?.budget_amount === null || campaign?.budget_amount === undefined
      ? ''
      : String(campaign.budget_amount),
  );
  const [externalId, setExternalId] = useState(campaign?.external_campaign_id ?? '');
  const [notes, setNotes] = useState(campaign?.notes ?? '');
  const [requestId] = useState(newRequestId);

  const defaultScope = scope.data
    ? scope.data.can_use_organization_scope
      ? 'organization'
      : (scope.data.branches[0]?.id ?? '')
    : '';
  const effectiveScope = scopeValue || defaultScope;
  const budgetAmount = optionalNumber(budget);
  const datesValid = !startsOn || !endsOn || endsOn >= startsOn;
  const canSave =
    name.trim().length >= 2 &&
    name.trim().length <= 180 &&
    Boolean(effectiveScope) &&
    datesValid &&
    (budgetAmount === null || (Number.isFinite(budgetAmount) && budgetAmount >= 0));

  const mutation = useMutation({
    mutationFn: () =>
      saveMarketingCampaign({
        campaignId: campaign?.id ?? null,
        expectedVersion: campaign?.version ?? null,
        name: name.trim(),
        platform,
        canonicalSource: source,
        status,
        branchId: effectiveScope === 'organization' ? null : effectiveScope,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        budgetAmount,
        currencyCode: campaign?.currency_code ?? 'INR',
        externalCampaignId: externalId.trim() || null,
        notes: notes.trim() || null,
        requestId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: campaign ? 'Campaign updated' : 'Campaign created',
        description: 'Leads whose campaign matches this name or ads campaign ID are counted here.',
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKey });
      onDone();
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Campaign was not saved',
        description: getCampaignErrorMessage(error),
      }),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Megaphone className="size-5 text-blue-600" />
          {campaign ? 'Edit campaign' : 'New campaign'}
        </DialogTitle>
        <DialogDescription>
          Leads are attributed when the campaign they arrive with matches this name or the ads
          campaign ID.
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) mutation.mutate();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Campaign name
          <Input
            value={name}
            maxLength={180}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Monsoon SUV Lead Campaign"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Platform
          <Select
            value={platform}
            onValueChange={(value) => setPlatform(value as CampaignPlatform)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campaignPlatforms.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Lead source
          <Select value={source} onValueChange={(value) => setSource(value as CampaignSource)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campaignSources.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Status
          <Select value={status} onValueChange={(value) => setStatus(value as CampaignStatus)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campaignStatuses.map((option) => (
                <SelectItem key={option} value={option}>
                  {marketingLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Scope
          <Select value={effectiveScope} onValueChange={setScopeValue}>
            <SelectTrigger>
              <SelectValue
                placeholder={scope.isPending ? 'Loading branches…' : 'Select an authorized scope'}
              />
            </SelectTrigger>
            <SelectContent>
              {scope.data?.can_use_organization_scope ? (
                <SelectItem value="organization">Organization-wide</SelectItem>
              ) : null}
              {scope.data?.branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Starts on
          <Input
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Ends on
          <Input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          {!datesValid ? (
            <span className="text-xs font-normal text-destructive">
              The end date must be on or after the start date.
            </span>
          ) : null}
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Budget (INR)
          <Input
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Ads campaign ID
          <Input
            value={externalId}
            maxLength={200}
            onChange={(event) => setExternalId(event.target.value)}
            placeholder="Optional, from Meta or Google Ads"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Notes
          <Textarea
            value={notes}
            maxLength={4000}
            onChange={(event) => setNotes(event.target.value)}
            className="min-h-20 resize-y"
          />
        </label>
        <DialogFooter className="sm:col-span-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function NewCampaignButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New campaign
      </Button>
      <CampaignFormDialog campaign={null} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function CampaignSpendDialog({
  campaign,
  open,
  onOpenChange,
}: {
  campaign: MarketingCampaignRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && campaign ? (
          <CampaignSpendForm
            key={campaign.id}
            campaign={campaign}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CampaignSpendForm({
  campaign,
  onDone,
}: {
  campaign: MarketingCampaignRecord;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const today = todayInKolkata();
  const [metricDate, setMetricDate] = useState(today);
  const [spend, setSpend] = useState('');
  const [impressions, setImpressions] = useState('');
  const [clicks, setClicks] = useState('');
  const [requestId] = useState(newRequestId);
  const spendAmount = optionalNumber(spend);
  const impressionCount = optionalNumber(impressions);
  const clickCount = optionalNumber(clicks);
  const wholeOrEmpty = (value: number | null) =>
    value === null || (Number.isInteger(value) && value >= 0);
  const canSave =
    Boolean(metricDate) &&
    metricDate <= today &&
    spendAmount !== null &&
    Number.isFinite(spendAmount) &&
    spendAmount >= 0 &&
    wholeOrEmpty(impressionCount) &&
    wholeOrEmpty(clickCount) &&
    (impressionCount === null || clickCount === null || clickCount <= impressionCount);

  const mutation = useMutation({
    mutationFn: () =>
      recordMarketingCampaignMetrics({
        campaignId: campaign.id,
        metricDate,
        spendAmount: spendAmount ?? 0,
        impressions: impressionCount,
        clicks: clickCount,
        requestId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Spend recorded',
        description: `${campaign.name} · ${metricDate}. Entering the same day again replaces it.`,
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKey });
      onDone();
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Spend was not recorded',
        description: getCampaignErrorMessage(error),
      }),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <IndianRupee className="size-5 text-blue-600" /> Record spend
        </DialogTitle>
        <DialogDescription>
          One day of spend for {campaign.name}, from the ads manager. Cost per lead uses these
          figures only.
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) mutation.mutate();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          Date
          <Input
            type="date"
            value={metricDate}
            max={today}
            onChange={(event) => setMetricDate(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Amount spent ({campaign.currency_code})
          <Input
            inputMode="decimal"
            value={spend}
            onChange={(event) => setSpend(event.target.value)}
            placeholder="e.g. 4500"
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Impressions
            <Input
              inputMode="numeric"
              value={impressions}
              onChange={(event) => setImpressions(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Clicks
            <Input
              inputMode="numeric"
              value={clicks}
              onChange={(event) => setClicks(event.target.value)}
              placeholder="Optional"
            />
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Record spend
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
