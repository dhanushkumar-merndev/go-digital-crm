'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, QrCode, ShieldAlert, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  disconnectPersonalWhatsApp,
  fetchPersonalWhatsAppStatus,
  personalWhatsAppReason,
  startPersonalWhatsApp,
} from './personal-whatsapp-api';

function QrCanvas({ value }: { value: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) void QRCode.toCanvas(canvas.current, value, { width: 224, margin: 2 });
    const current = canvas.current;
    return () => {
      current?.getContext('2d')?.clearRect(0, 0, 224, 224);
    };
  }, [value]);
  return (
    <canvas
      ref={canvas}
      aria-label="Scan this QR code using WhatsApp Linked devices"
      className="mx-auto rounded-lg"
    />
  );
}

export function PersonalWhatsAppDialog({ scope }: { scope: readonly unknown[] }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['personal-whatsapp-link', ...scope],
    queryFn: ({ signal }) => fetchPersonalWhatsAppStatus(undefined, signal),
    enabled: open,
    refetchInterval: open ? 3000 : false,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
  });
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['personal-whatsapp-link', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['personal-whatsapp-status', ...scope] }),
      queryClient.invalidateQueries({ queryKey: ['shared-inbox', ...scope] }),
    ]);
  };
  const link = useMutation({ mutationFn: startPersonalWhatsApp, onSuccess: refresh });
  const disconnect = useMutation({
    mutationFn: () => disconnectPersonalWhatsApp(status.data!.connection_id),
    onSuccess: async () => {
      queryClient.setQueryData(['personal-whatsapp-link', ...scope], null);
      await refresh();
    },
  });
  const data = status.data;
  const connected = data?.enabled && data.status === 'CONNECTED';
  const expired =
    data && Date.parse(data.attempt_expires_at) <= now && !connected && !data.masked_phone;
  const qrValid =
    data?.qr && data.qr_expires_at && Date.parse(data.qr_expires_at) > now && !expired;
  const working = data?.enabled && !expired && !connected;
  const busy = link.isPending || disconnect.isPending;
  const error = link.error ?? disconnect.error;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Smartphone className="size-4" /> Connect my WhatsApp
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            queryClient.removeQueries({ queryKey: ['personal-whatsapp-link', ...scope] });
            link.reset();
            disconnect.reset();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Connect my WhatsApp{' '}
              <Badge variant="secondary" className="ml-2">
                Experimental
              </Badge>
            </DialogTitle>
            <DialogDescription>Your number, connected to your customer inbox.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <ShieldAlert className="size-4" /> Unofficial connection
            </div>
            WhatsApp may restrict or ban your number even with reply limits. Use the official
            Business Platform for production reliability.
          </div>
          {status.isPending ? (
            <p className="flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" /> Checking connection…
            </p>
          ) : status.isError ? (
            <div className="space-y-2 text-sm">
              <p>Connection status is unavailable. Personal WhatsApp may not be deployed yet.</p>
              <Button variant="outline" onClick={() => void status.refetch()}>
                Try again
              </Button>
            </div>
          ) : connected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{data.masked_phone}</p>
                <Badge variant="success">Connected</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {data.daily_sent} / {data.daily_limit} CRM replies in the last 24 hours.
              </p>
              <p className="text-xs text-muted-foreground">
                Last connection check:{' '}
                {data.heartbeat_at ? new Date(data.heartbeat_at).toLocaleTimeString() : 'Waiting'}
              </p>
              <p className="text-sm">
                New messages from your CRM contacts appear in My WhatsApp. Earlier chat history is
                not imported.
              </p>
            </div>
          ) : working ? (
            <div className="space-y-3 text-center">
              {qrValid ? (
                <>
                  <QrCanvas value={data.qr!} />
                  <p className="text-xs text-muted-foreground">
                    QR refreshes in{' '}
                    {Math.max(0, Math.ceil((Date.parse(data.qr_expires_at!) - now) / 1000))} seconds
                  </p>
                </>
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3">
                  <LoaderCircle className="size-6 animate-spin" />
                  <p className="text-sm">
                    {data.masked_phone ? 'Reconnecting your WhatsApp…' : 'Preparing your QR code…'}
                  </p>
                </div>
              )}
              <p className="text-sm">
                On your phone, open WhatsApp → Linked devices → Link a device, then scan the QR
                code.
              </p>
              <p className="text-xs text-muted-foreground">
                The pilot server can take about a minute to wake up.
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {expired && (
                <p className="font-medium text-amber-800">
                  This link attempt expired. Scan again to start a fresh attempt.
                </p>
              )}
              <p>
                Only new one-to-one messages with contacts already in your accessible CRM records
                are saved. Unrelated personal chats and groups are discarded. Attachments are shown
                as placeholders.
              </p>
              <p>
                You can reply for 24 hours after a customer messages you. No first messages, bulk
                sends, campaigns, or automatic replies. Limit: 50 CRM replies per day, with
                additional cooldowns.
              </p>
              <Button className="w-full" disabled={busy} onClick={() => link.mutate()}>
                <QrCode className="size-4" />
                {link.isPending ? 'Starting…' : 'I agree — show QR code'}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {personalWhatsAppReason(error.message)}
            </p>
          )}
          {data?.enabled && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>
                {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => disconnect.mutate(undefined, { onSuccess: () => link.mutate() })}
              >
                <QrCode className="size-4" /> Scan again
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Disconnect stops CRM access and clears saved session keys. You can also remove this
            device in WhatsApp → Linked devices. Saved CRM messages remain under your account’s
            retention policy.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
