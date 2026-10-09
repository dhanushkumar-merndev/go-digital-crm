'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { toast } from '@/components/ui/toast';
import {
  createSmsFallbackCampaign,
  fetchMarketingAutomationScopeOptions,
  fetchMarketingDripBuilderOptions,
} from './marketing-automation-api';

export function SmsFallbackCampaignDialog({ onComplete }: { onComplete: () => void }) {
  const queryScope = workspaceQueryScope(useWorkspaceSession());
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('New lead thank-you - No email (SMS)');
  const [scope, setScope] = useState('');
  const [sourceGroup, setSourceGroup] = useState('all');
  const [templateId, setTemplateId] = useState('');
  const [variableMap, setVariableMap] = useState<Record<string, string>>({});
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const options = useQuery({
    queryKey: ['marketing-drip-builder-options', ...queryScope],
    queryFn: ({ signal }) => fetchMarketingDripBuilderOptions(signal),
    enabled: open,
  });
  const scopes = useQuery({
    queryKey: ['marketing-automation-scope-options', ...queryScope],
    queryFn: ({ signal }) => fetchMarketingAutomationScopeOptions(signal),
    enabled: open,
  });
  const selectedScope =
    scope ||
    (scopes.data?.can_use_organization_scope ? 'organization' : scopes.data?.branches[0]?.id || '');
  const templates = options.data?.templates.filter((t) => t.channel === 'SMS') || [];
  const template = templates.find((t) => t.id === templateId);
  const mutation = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      createSmsFallbackCampaign({
        name: name.trim(),
        branchId: selectedScope === 'organization' ? undefined : selectedScope,
        sources:
          sourceGroup === 'all'
            ? []
            : sourceGroup === 'other'
              ? ['Other']
              : options.data?.sources.filter((s) => s !== 'Other') || [],
        templateId,
        variableMap,
        requestId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'SMS fallback draft saved',
        description: 'Activate it after linking an approved MSG91 template.',
      });
      setOpen(false);
      setRequestId(crypto.randomUUID());
      onComplete();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'SMS fallback could not be saved',
        description: 'Check the scope, template and variable mappings, then try again.',
      }),
  });
  const valid =
    name.trim().length >= 3 &&
    Boolean(selectedScope) &&
    Boolean(template) &&
    template!.placeholders.every((p) => Boolean(variableMap[p])) &&
    options.data?.can_manage;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <MessageCircle className="size-4" />
        Create SMS fallback
      </Button>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>SMS thank-you fallback</DialogTitle>
            <DialogDescription>
              New leads receive this SMS only when neither the enquiry nor its linked customer has
              an email address. Sends immediately after matching.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) mutation.mutate();
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Campaign name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={180}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Authorized scope
              <Select value={selectedScope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue placeholder="Select scope" />
                </SelectTrigger>
                <SelectContent>
                  {scopes.data?.can_use_organization_scope && (
                    <SelectItem value="organization">Organization-wide</SelectItem>
                  )}
                  {scopes.data?.branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Lead sources
              <Select value={sourceGroup} onValueChange={setSourceGroup}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="named">Named sources</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              SMS template
              <Select
                value={templateId}
                onValueChange={(id) => {
                  setTemplateId(id);
                  setVariableMap({});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a thank-you template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.status.toLowerCase()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {template?.body && (
              <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{template.body}</p>
            )}
            {template?.placeholders.map((p) => (
              <label key={p} className="grid gap-1.5 text-sm font-medium">
                {p}
                <Select
                  value={variableMap[p] || ''}
                  onValueChange={(token) =>
                    setVariableMap((current) => ({ ...current, [p]: token }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a lead or customer field" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.data?.tokens.map((token) => (
                      <SelectItem key={token} value={token}>
                        {token.replaceAll('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
            {(options.isError || scopes.isError) && (
              <Alert variant="destructive">
                <AlertDescription>
                  Could not load campaign options. Close and reopen this dialog to try again.
                </AlertDescription>
              </Alert>
            )}
            {!options.isPending && !options.isError && !templates.length && (
              <Alert>
                <AlertDescription>
                  Create a marketing SMS template before saving the fallback.
                </AlertDescription>
              </Alert>
            )}
            {options.data && !options.data.channels.SMS && (
              <Alert>
                <AlertDescription>
                  Connect MSG91 in Tools before activating this campaign.
                </AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">
              Dormant leads and customers who opted out of SMS are excluded. The draft needs an
              approved MSG91 template before activation.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save draft'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
