'use client';

import Image from 'next/image';
import QRCode from 'qrcode';
import { LoaderCircle, QrCode } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient, hasSupabaseConfig } from '@/lib/supabase/client';

export function MobileLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [qr, setQr] = useState<string>();
  const [expiresAt, setExpiresAt] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const challengeInFlight = useRef(false);

  const createChallenge = useCallback(
    async (force = false) => {
      const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
      if ((qr && !force && !expired) || challengeInFlight.current) return;
      if (!hasSupabaseConfig()) {
        setError('Configure Supabase to create a secure one-time mobile link.');
        return;
      }
      challengeInFlight.current = true;
      if (force || expired) {
        setQr(undefined);
        setExpiresAt(undefined);
      }
      setLoading(true);
      setError(undefined);
      try {
        const { data, error: functionError } = await createClient().functions.invoke<{
          ok: boolean;
          data?: { qr_payload: string; expires_at: string };
        }>('mobile-link-create', { body: {} });
        if (functionError || !data?.data) throw functionError ?? new Error('CHALLENGE_MISSING');
        const challenge = data.data;
        setQr(
          await QRCode.toDataURL(challenge.qr_payload, {
            width: 240,
            margin: 1,
            errorCorrectionLevel: 'M',
          }),
        );
        setExpiresAt(challenge.expires_at);
      } catch {
        setError('A mobile link could not be created. Check your session and try again.');
      } finally {
        challengeInFlight.current = false;
        setLoading(false);
      }
    },
    [expiresAt, qr],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={() => void createChallenge()}>
        <DialogHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-700">
            <QrCode className="size-5" />
          </div>
          <DialogTitle>Link mobile app</DialogTitle>
          <DialogDescription>
            Scan this short-lived, one-time challenge with the Go Digital Marketing CRM mobile app.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 grid min-h-64 place-items-center rounded-xl border bg-muted/25 p-5">
          {loading ? (
            <LoaderCircle className="size-6 animate-spin text-primary" />
          ) : qr ? (
            <Image
              unoptimized
              src={qr}
              width={240}
              height={240}
              alt="One-time mobile app linking QR code"
            />
          ) : (
            <p className="max-w-xs text-center text-sm text-destructive">{error}</p>
          )}
        </div>
        {expiresAt && (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Expires at{' '}
            {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It
            becomes invalid immediately after use.
          </p>
        )}
        <Button
          variant="outline"
          className="mt-3 w-full"
          onClick={() => void createChallenge(true)}
        >
          Generate a new code
        </Button>
      </DialogContent>
    </Dialog>
  );
}
