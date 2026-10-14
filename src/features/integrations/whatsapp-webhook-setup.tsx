'use client';

import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

export type WhatsAppWebhookMode = 'DEALERSHIP_APP' | 'PLATFORM_APP';

/**
 * Where Meta should deliver this connection's WhatsApp events. A dealership on
 * its own Meta app gets a callback URL tied to its connection, verified with
 * the token it entered; the stored token and app secret are never shown again.
 */
export function WhatsAppWebhookSetup({
  webhookUrl,
  mode,
}: {
  webhookUrl: string | undefined;
  mode: WhatsAppWebhookMode | undefined;
}) {
  if (mode !== 'DEALERSHIP_APP' || !webhookUrl)
    return (
      <section className="space-y-1 rounded-lg border p-4">
        <h3 className="font-medium">Webhook setup</h3>
        <p className="text-sm text-muted-foreground">
          This connection uses the Go Digital Marketing Meta app, whose webhook is managed by Go
          Digital Marketing. To receive messages through your own Meta app, replace the credential
          and enter its app secret and a webhook verify token.
        </p>
      </section>
    );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.add({ type: 'success', title: 'Callback URL copied' });
    } catch {
      toast.add({
        type: 'error',
        title: 'Copy failed',
        description: 'Select the URL and copy it.',
      });
    }
  };

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">Webhook setup</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          In Meta, open your app → WhatsApp → Configuration → Webhook, and enter:
        </p>
      </div>
      <div className="grid gap-1.5 text-sm font-medium">
        Callback URL
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label="WhatsApp webhook callback URL"
            className="font-mono text-[11px]"
            value={webhookUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" variant="outline" size="icon" onClick={() => void copy()}>
            <Copy className="size-4" />
            <span className="sr-only">Copy callback URL</span>
          </Button>
        </div>
      </div>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="font-medium">Verify token</dt>
          <dd className="text-muted-foreground">
            The verify token you entered when connecting. It is stored encrypted and not shown
            again; replace the credential to set a new one.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Webhook fields</dt>
          <dd className="text-muted-foreground">
            Subscribe to <span className="font-mono">messages</span>. It carries customer replies
            and sent, delivered, read and failed statuses.
          </dd>
        </div>
      </dl>
    </section>
  );
}
