'use client';

import { useCallback } from 'react';
import { CANVAS_ZOOM_CHANGED_EVENT } from './viewport-scale';

/**
 * Returns a ref that sizes its element to reach the bottom of the window, less
 * `bottomGap` CSS px.
 *
 * `100vh` cannot do this under the canvas zoom: browsers disagree on whether
 * viewport units are scaled by `zoom` on the root, so a `100vh / zoom` formula
 * fits in one browser and leaves a band of empty page (or overflows) in
 * another. Measuring avoids the question: the window height and the element's
 * rect share one coordinate space in every browser, and the rect-to-CSS ratio
 * converts the result back into the element's own pixels.
 */
export function useFillViewportHeight(bottomGap: number) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      const fit = () => {
        const rect = element.getBoundingClientRect();
        const cssHeight = Number.parseFloat(getComputedStyle(element).height);
        if (!rect.height || !cssHeight) return;
        const scale = rect.height / cssHeight;
        const available = window.innerHeight - rect.top - bottomGap * scale;
        element.style.height = `${Math.max(available / scale, 320)}px`;
      };
      // Ref callbacks run in the commit, so the first fit lands before paint.
      fit();
      window.addEventListener('resize', fit);
      window.addEventListener(CANVAS_ZOOM_CHANGED_EVENT, fit);
      return () => {
        window.removeEventListener('resize', fit);
        window.removeEventListener(CANVAS_ZOOM_CHANGED_EVENT, fit);
      };
    },
    [bottomGap],
  );
}
