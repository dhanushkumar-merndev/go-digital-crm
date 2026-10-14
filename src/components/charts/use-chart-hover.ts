'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { readCanvasZoom } from '@/lib/layout/viewport-scale';

type ChartHoverState = {
  hoveredIndex: number | null;
  setHoveredIndex: (index: number | null) => void;
};

/** Each chart/table pair owns its transient hover state, with no persistence. */
export function useChartHover() {
  const [store] = useState(() =>
    createStore<ChartHoverState>((set) => ({
      hoveredIndex: null,
      setHoveredIndex: (hoveredIndex) =>
        set((state) => (state.hoveredIndex === hoveredIndex ? state : { hoveredIndex })),
    })),
  );
  return useStore(store);
}

/** Keeps the highlighted row visible within the shadcn Table's scroll container. */
export function useChartTableScroll(hovered: string | number | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const container = containerRef.current?.firstElementChild;
    const row = activeRowRef.current;
    if (hovered === null || !(container instanceof HTMLElement) || !row) return;
    const containerBox = container.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    // Rectangles include the workspace's CSS zoom; scrollTop uses layout pixels.
    const zoom = readCanvasZoom();
    const visibleTop = containerBox.top + container.clientTop * zoom;
    // clientHeight excludes a horizontal scrollbar, unlike the outer rectangle.
    const visibleBottom = visibleTop + container.clientHeight * zoom;
    if (rowBox.top < visibleTop + headerHeight) {
      container.scrollTop += (rowBox.top - visibleTop - headerHeight) / zoom;
    } else if (rowBox.bottom > visibleBottom) {
      container.scrollTop += (rowBox.bottom - visibleBottom) / zoom;
    }
  }, [hovered]);
  return { containerRef, activeRowRef };
}
