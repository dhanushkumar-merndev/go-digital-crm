'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { applyViewportZoom, canvasEnabled, storeCanvasEnabled } from '@/lib/layout/viewport-scale';

/**
 * One preference, read by both the component that applies the zoom and the
 * menu item that switches it, so the two can never disagree. It lives outside
 * React because the pre-paint script has already acted on it before React
 * exists.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab of the same workspace should follow along.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

/**
 * `true` on the server and through hydration: the canvas is the default, so
 * the markup React sends and the markup it hydrates agree, and a browser that
 * has switched it off only re-renders afterwards.
 */
export function useFixedCanvas() {
  const enabled = useSyncExternalStore(subscribe, canvasEnabled, () => true);
  const setEnabled = useCallback((next: boolean) => {
    storeCanvasEnabled(next);
    applyViewportZoom(document.documentElement, next);
    notify();
  }, []);
  return { enabled, setEnabled };
}

/**
 * Keeps the page on its design canvas as the window changes size. The
 * pre-paint script in the document head does the first pass; this keeps it
 * current through resizes, monitor changes and the menu switch.
 */
export function ViewportScale() {
  const { enabled } = useFixedCanvas();
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyViewportZoom(root, enabled));
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      root.style.zoom = '';
    };
  }, [enabled]);
  return null;
}
