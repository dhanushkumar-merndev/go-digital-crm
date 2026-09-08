'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, QrCode, ShieldAlert, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
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
  checkPersonalWhatsAppAvailability,
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
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['personal-whatsapp-link', ...scope],
    queryFn: ({ signal }) => fetchPersonalWhatsAppStatus(undefined, signal),
    enabled: open,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!open || !data?.enabled || query.state.error) return false;
      if (data.status === 'CONNECTED') return 15000;
      return Date.parse(data.attempt_expires_at) > Date.now() || data.masked_phone ? 2000 : false;
    },
    staleTime: 10000,
    gcTime: 0,
    retry: false,
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
  const availability = useMutation({
    mutationFn: checkPersonalWhatsAppAvailability,
    retry: false,
    onSuccess: (data) => {
      queryClient.setQueryData(['personal-whatsapp-link', ...scope], data);
      setNow(Date.now());
      setShowDetails(false);
      setOpen(true);
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'WhatsApp is unavailable',
        description: 'Connection service is offline or still starting. Try again shortly.',
      }),
  });
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
      <Button
        variant="outline"
        size="sm"
        disabled={availability.isPending}
        onClick={() => availability.mutate()}
      >
        {availability.isPending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Smartphone className="size-4" />
        )}
        {availability.isPending ? 'Checking…' : 'Connect my WhatsApp'}
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
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Unofficial connection. WhatsApp may restrict or ban this number.</span>
          </div>
          {status.isPending ? (
            <p className="flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" /> Checking connection…
            </p>
          ) : status.isError ? (
            <div className="space-y-2 text-sm">
              <p>Connection status is unavailable.</p>
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
              <p className="text-xs text-muted-foreground">
                Text-only sync · CRM contacts · Up to 30 days
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
              <p className="text-xs text-muted-foreground">
                WhatsApp → Linked devices → Link a device
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {expired && (
                <p className="text-xs text-amber-800">QR expired. Generate a new code below.</p>
              )}
              <p className="text-xs text-muted-foreground">
                Text only · CRM contacts only · 50 replies/day
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto justify-start px-0 text-xs text-muted-foreground"
            aria-expanded={showDetails}
            aria-controls="whatsapp-connection-details"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? 'Hide details' : 'Connection details'}
          </Button>
          {showDetails && (
            <div
              id="whatsapp-connection-details"
              className="space-y-2 text-xs text-muted-foreground"
            >
              <p>
                Replies are available for 24 hours after a customer messages you. No first messages,
                campaigns, or automatic replies.
              </p>
              <p>
                Only accessible CRM contacts are saved. Groups and media are skipped. Available
                history up to 30 days appears in All enquiries; keep your phone online.
              </p>
              <p>
                Disconnect removes saved session keys. Existing CRM messages follow your account’s
                retention policy.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
