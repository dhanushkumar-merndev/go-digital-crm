'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  websiteEmbedSnippet,
  type WebsiteWidgetConfig,
} from '@/lib/providers/website-lead-adapter';
import { IntegrationRequestError } from '../integration-workspace-api';
import {
  createLeadApiKey,
  fetchLeadApiKeys,
  leadApiEndpoint,
  revokeLeadApiKey,
  type LeadApiKeyRecord,
} from './website-integration-api';

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.add({ type: 'success', title: `${label} copied` });
  } catch {
    toast.add({ type: 'error', title: 'Copy failed', description: 'Select the text and copy it.' });
  }
}

function CopyField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="grid gap-1.5 text-sm font-medium">
      {label}
      <div className="flex items-start gap-2">
        {multiline ? (
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed font-normal whitespace-pre-wrap break-all">
            {value}
          </pre>
        ) : (
          <Input
            readOnly
            aria-label={label}
            className="font-mono text-[11px]"
            value={value}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void copyText(value, label)}
        >
          <Copy className="size-4" />
          <span className="sr-only">Copy {label}</span>
        </Button>
      </div>
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

function curlExample(endpoint: string) {
  return `curl -X POST '${endpoint}' \\
  -H 'Authorization: Bearer gdm_live_xxxxxxxx_...' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: <your-form-submission-id>' \\
  -d '{
    "customer_name": "Ravi Kumar",
    "phone": "9876543210",
    "email": "ravi@example.com",
    "interested_model": "Nexon",
    "campaign": "Diwali website offer",
    "branch_code": "BLR-01",
    "city": "Bengaluru",
    "message": "Looking for a test drive this weekend",
    "requirements": {
      "budget_min": 800000,
      "budget_max": 1200000,
      "purchase_timeline": "Within 1 month",
      "finance_required": true,
      "exchange_required": false,
      "test_drive_required": true
    }
  }'`;
}

function ApiKeysSection({
  organizationId,
  connectionId,
  canManage,
}: {
  organizationId: string;
  connectionId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['lead-api-keys', organizationId, connectionId];
  const keys = useQuery({ queryKey, queryFn: () => fetchLeadApiKeys(connectionId) });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<LeadApiKeyRecord | null>(null);

  const create = useMutation({
    mutationFn: () => createLeadApiKey({ organizationId, connectionId, name: name.trim() }),
    meta: { toast: false },
    onSuccess: (result) => {
      setIssuedKey(result.api_key);
      setName('');
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (key: LeadApiKeyRecord) => revokeLeadApiKey(key.id),
    onSuccess: () => {
      setRevoking(null);
      toast.add({ type: 'success', title: 'API key revoked' });
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  function closeCreate() {
    setCreateOpen(false);
    setIssuedKey(null);
    setName('');
    create.reset();
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">API keys</h4>
        {canManage ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Create key
          </Button>
        ) : null}
      </div>
      {keys.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : keys.isError ? (
        <Alert>
          <AlertDescription>API keys could not be loaded.</AlertDescription>
        </Alert>
      ) : keys.data.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          No API keys yet. Create one for each system that sends leads, so each can be revoked on
          its own.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-[11px]">
                    gdm_live_{key.key_prefix}_••••
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDate(key.last_used_at)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={key.revoked_at ? 'Revoked' : 'Active'} />
                  </TableCell>
                  <TableCell>
                    {canManage && !key.revoked_at ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setRevoking(key)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => !open && closeCreate()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{issuedKey ? 'Copy your API key now' : 'Create Lead API key'}</DialogTitle>
            <DialogDescription>
              {issuedKey
                ? 'This is the only time the key is shown. Store it in your server’s secret settings — never in website JavaScript.'
                : 'Name the system that will use it, for example “Website backend” or “Zapier”.'}
            </DialogDescription>
          </DialogHeader>
          {issuedKey ? (
            <CopyField label="API key" value={issuedKey} />
          ) : (
            <form
              id="create-lead-api-key"
              onSubmit={(event) => {
                event.preventDefault();
                // React bubbles events through portals: without this the submit
                // also reaches the connection form this panel sits in after a
                // save, which would save the connection a second time.
                event.stopPropagation();
                create.mutate();
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={80}
                required
                placeholder="Website backend"
                aria-label="Key name"
              />
              {create.isError ? (
                <p className="mt-2 text-sm text-destructive">
                  {create.error instanceof IntegrationRequestError
                    ? create.error.message
                    : 'The key could not be created.'}
                </p>
              ) : null}
            </form>
          )}
          <DialogFooter>
            {issuedKey ? (
              <Button type="button" onClick={closeCreate}>
                I have stored the key
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={closeCreate}>
                  Cancel
                </Button>
                <Button type="submit" form="create-lead-api-key" disabled={create.isPending}>
                  <KeyRound className="size-4" />
                  {create.isPending ? 'Creating…' : 'Create key'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(revoking)} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Revoke “{revoking?.name}”?</DialogTitle>
            <DialogDescription>
              Requests using this key are rejected immediately. This cannot be undone; create a new
              key to replace it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking)}
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function WebsiteConnectionPanel({
  organizationId,
  connectionId,
  publicKey,
  widget,
  canManage,
}: {
  organizationId: string;
  connectionId: string;
  publicKey: string | undefined;
  widget: WebsiteWidgetConfig | undefined;
  canManage: boolean;
}) {
  const crmOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const endpoint = leadApiEndpoint();
  return (
    <div className="grid gap-4">
      {widget?.widget_enabled && publicKey ? (
        <section className="grid gap-3 rounded-lg border p-4">
          <div>
            <h3 className="font-medium">Chat widget</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Paste this just before <code className="text-xs">&lt;/body&gt;</code> on every page of
              the website. It is safe to publish — the key only lets visitors submit enquiries to
              this connection, from the allowed domains.
            </p>
          </div>
          <CopyField
            label="Embed code"
            value={websiteEmbedSnippet(crmOrigin, publicKey)}
            multiline
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Allowed on:</span>
            {widget.allowed_origins.map((origin) => (
              <code key={origin} className="rounded bg-muted px-1.5 py-0.5">
                {origin}
              </code>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="w-fit" asChild>
            <a href={`/embed/chat/${publicKey}`} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Preview chat
            </a>
          </Button>
        </section>
      ) : null}
      {widget?.api_enabled ? (
        <section className="grid gap-3 rounded-lg border p-4">
          <div>
            <h3 className="font-medium">Lead API</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              For server-to-server use only. Send <code className="text-xs">POST</code> JSON with
              the key in the <code className="text-xs">Authorization</code> header. Required:
              customer_name and phone; everything else is optional. Repeating an Idempotency-Key
              returns the first lead instead of creating a duplicate.
            </p>
          </div>
          <CopyField label="Endpoint" value={endpoint} />
          <CopyField label="Example request" value={curlExample(endpoint)} multiline />
          <ApiKeysSection
            organizationId={organizationId}
            connectionId={connectionId}
            canManage={canManage}
          />
        </section>
      ) : null}
      {!widget?.widget_enabled && !widget?.api_enabled ? (
        <Alert>
          <AlertTitle>Both channels are off</AlertTitle>
          <AlertDescription>
            Edit this connection to switch on the chat widget or the Lead API.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
