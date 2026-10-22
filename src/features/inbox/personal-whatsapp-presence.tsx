'use client';

import { useEffect } from 'react';
import { reportPersonalWhatsAppPresence, startPersonalWhatsApp } from './personal-whatsapp-api';

const PRESENCE_INTERVAL_MS = 2 * 60_000;
// A reconnect that did not bring the socket back is retried with a growing
// gap, so a gateway that stays down is not asked again on every ping, tab
// focus and page load. Presence itself keeps its fixed cadence.
const RECONNECT_BACKOFF_MS = [0, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
// The backoff outlives a full page load: it lived in memory, so every reload
// asked the gateway again at once and a full server answered 409 each time.
const BACKOFF_STORAGE_KEY = 'gdm-personal-whatsapp-reconnect';

type ReconnectBackoff = { attempts: number; lastAt: number };

function readBackoff(): ReconnectBackoff {
  try {
    const stored = JSON.parse(sessionStorage.getItem(BACKOFF_STORAGE_KEY) ?? 'null');
    if (typeof stored?.attempts === 'number' && typeof stored?.lastAt === 'number') return stored;
  } catch {
    /* Storage blocked or corrupt: start a fresh backoff. */
  }
  return { attempts: 0, lastAt: 0 };
}

function writeBackoff(backoff: ReconnectBackoff) {
  try {
    sessionStorage.setItem(BACKOFF_STORAGE_KEY, JSON.stringify(backoff));
  } catch {
    /* Best effort; the in-memory copy still spaces the retries. */
  }
}

/**
 * Keeps the user's personal WhatsApp counted as online while the CRM is open
 * and visible. The gateway pauses the socket of someone away for 10 minutes
 * when it needs room; this reconnects it as soon as they are back.
 */
export function PersonalWhatsAppPresence() {
  useEffect(() => {
    let running = false;
    let backoff = readBackoff();
    const ping = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const presence = await reportPersonalWhatsAppPresence();
        if (presence?.live || !presence?.linked) {
          if (backoff.attempts) writeBackoff((backoff = { attempts: 0, lastAt: 0 }));
          return;
        }
        // A linked number whose socket was paused (or refused while the
        // server was full) asks for a reconnect; a busy server answers with
        // PERSONAL_WHATSAPP_CAPACITY and a later ping tries again.
        const gap =
          RECONNECT_BACKOFF_MS[Math.min(backoff.attempts, RECONNECT_BACKOFF_MS.length - 1)]!;
        if (presence.status !== 'CONNECTING' && Date.now() - backoff.lastAt >= gap) {
          writeBackoff((backoff = { attempts: backoff.attempts + 1, lastAt: Date.now() }));
          await startPersonalWhatsApp();
        }
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
