'use client';

import { useEffect } from 'react';
import { reportPersonalWhatsAppPresence, startPersonalWhatsApp } from './personal-whatsapp-api';

const PRESENCE_INTERVAL_MS = 2 * 60_000;

/**
 * Keeps the user's personal WhatsApp counted as online while the CRM is open
 * and visible. The gateway pauses the socket of someone away for 10 minutes
 * when it needs room; this reconnects it as soon as they are back.
 */
export function PersonalWhatsAppPresence() {
  useEffect(() => {
    let running = false;
    const ping = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const presence = await reportPersonalWhatsAppPresence();
        // A linked number whose socket was paused (or refused while the
        // server was full) asks for a reconnect; a busy server answers with
        // PERSONAL_WHATSAPP_CAPACITY and the next ping tries again.
        if (presence?.linked && !presence.live && presence.status !== 'CONNECTING')
          await startPersonalWhatsApp();
      } catch {
        /* Presence is best effort; the next ping retries. */
      } finally {
        running = false;
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), PRESENCE_INTERVAL_MS);
    const onVisible = () => void ping();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return null;
}
