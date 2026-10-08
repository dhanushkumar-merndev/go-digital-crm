'use client';

import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';
import { CANVAS_ZOOM_CHANGED_EVENT, readCanvasZoom } from '@/lib/layout/viewport-scale';
import type { ChartKind } from '@/lib/domain';

type Datum = { name: string; value: number; secondary?: number };
type SeriesNames = [string, string];
type FunnelMode = 'proportional' | 'staged';
/** `inside`: names on the bands. `side`: funnel on the left, names and counts in a column on the right. */
type FunnelLabels = 'inside' | 'side';
/** Extra series for bar/line charts that compare more than two measures. */
export type ChartSeries = { name: string; values: number[] };
type ExtraOptions = {
  series?: ChartSeries[];
  stacked?: boolean;
  funnelStages?: number;
  funnelLabels?: FunnelLabels;
  colors?: string[];
};

const palette = [
  '#2563eb',
  '#14b8a6',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#0ea5e9',
  '#22c55e',
  '#ec4899',
  '#64748b',
  '#a16207',
  '#4f46e5',
];

/**
 * `scale` is the canvas zoom. The chart draws in physical pixels (see EChart
 * below), so every size in here is multiplied by it to stay the same size as
 * the page around it -- otherwise a 12px axis label would out-size 12px body
 * text by the inverse of the zoom.
 */
function optionFor(
  kind: ChartKind,
  data: Datum[],
  seriesNames?: SeriesNames,
  funnelMode: FunnelMode = 'proportional',
  scale = 1,
  extra: ExtraOptions = {},
): echarts.EChartsCoreOption {
  const funnelStages = extra.funnelStages ?? 5;
  const text = '#667085';
  const px = (value: number) => value * scale;
  const grid = { left: px(42), right: px(20), top: px(20), bottom: px(32) };
  const textStyle = { fontSize: px(12) };
  if (kind === 'donut')
    return {
      textStyle,
      tooltip: { trigger: 'item', textStyle },
      legend: { bottom: 0, textStyle: { color: text, ...textStyle } },
      color: data.length > 5 ? palette : ['#2563eb', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444'],
      series: [
        {
          type: 'pie',
          radius: ['52%', '72%'],
          center: ['50%', '43%'],
          label: { show: false },
          data,
        },
      ],
    };
  if (kind === 'funnel') {
    const side = funnelMode === 'staged' && extra.funnelLabels === 'side';
    const funnelData =
      funnelMode === 'staged'
        ? data.slice(0, funnelStages).map((item, index, items) => ({
            name: side ? item.name : `${item.name}   ${item.value}`,
            value: items.length - index,
            count: item.value,
          }))
        : data.slice(0, funnelStages);
    const stagedTooltip = (params: { name: string; data: { count?: number } }) =>
      side ? `${params.name}: ${params.data.count ?? 0}` : params.name;
    return {
      textStyle,
      tooltip: {
        trigger: 'item',
        textStyle,
        formatter: funnelMode === 'staged' ? stagedTooltip : undefined,
      },
      color:
        funnelMode === 'staged'
          ? ['#1769e8', '#58a4e8', '#18b8bd', '#8b5de7', '#55c58a', '#f2a33a', '#e5679a']
          : ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd'],
      series: [
        {
          type: 'funnel',
          top: px(4),
          bottom: px(4),
          left: '2%',
          width: side ? '66%' : '96%',
          min: funnelMode === 'staged' ? 1 : undefined,
          max: funnelMode === 'staged' ? Math.max(funnelData.length, 1) : undefined,
          minSize: funnelMode === 'staged' ? '34%' : '25%',
          maxSize: '100%',
          sort: funnelMode === 'staged' ? 'none' : 'descending',
          funnelAlign: 'center',
          gap: px(2),
          label: side
            ? {
                position: 'right',
                formatter: (params: { name: string; data: { count?: number } }) =>
                  `{name|${params.name}}{count|${(params.data.count ?? 0).toLocaleString('en-IN')}}`,
                rich: {
                  name: { color: text, fontSize: px(12), width: px(110) },
                  count: { color: '#101828', fontSize: px(13), fontWeight: 600 },
                },
              }
            : { color: '#fff', fontSize: px(11), fontWeight: 500 },
          // Every label starts at the same x, so the names and counts read as one column.
          labelLayout: side ? { x: '71%', align: 'left' } : undefined,
          labelLine: { show: false },
          itemStyle: { borderColor: '#fff', borderWidth: px(1) },
          emphasis: { label: { fontSize: side ? undefined : px(11) } },
          data: funnelData,
        },
      ],
    };
  }
  const common = {
    textStyle,
    tooltip: { trigger: 'axis', textStyle },
    grid,
    legend: { top: 0, right: 0, textStyle: { color: text, ...textStyle } },
    xAxis: {
      type: 'category' as const,
      data: data.map((item) => item.name),
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
      axisLabel: { color: text, ...textStyle },
    },
    yAxis: {
      type: 'value' as const,
      splitLine: { lineStyle: { color: '#eef1f5' } },
      axisLabel: { color: text, ...textStyle },
    },
  };
  if ((kind === 'bar' || kind === 'line') && extra.series?.length)
    return {
      ...common,
      color: extra.colors ?? palette,
      series: extra.series.map((series) => ({
        name: series.name,
        type: kind,
        stack: extra.stacked ? 'total' : undefined,
        smooth: kind === 'line' ? true : undefined,
        symbolSize: kind === 'line' ? px(6) : undefined,
        barMaxWidth: kind === 'bar' ? px(extra.stacked ? 34 : 18) : undefined,
        itemStyle:
          kind === 'bar' && !extra.stacked ? { borderRadius: [px(4), px(4), 0, 0] } : undefined,
        data: series.values,
      })),
    };
  if (kind === 'bar')
    return {
      ...common,
      color: ['#2563eb', '#bfdbfe'],
      series: [
        {
          name: seriesNames?.[0] ?? 'Actual',
          type: 'bar',
          barMaxWidth: px(22),
          itemStyle: { borderRadius: [px(4), px(4), 0, 0] },
          data: data.map((item) => item.value),
        },
        ...(data.some((item) => item.secondary !== undefined)
          ? [
              {
                name: seriesNames?.[1] ?? 'Target',
                type: 'bar' as const,
                barMaxWidth: px(22),
                itemStyle: { borderRadius: [px(4), px(4), 0, 0] },
                data: data.map((item) => item.secondary),
              },
            ]
          : []),
      ],
    };
  return {
    ...common,
    color: ['#2563eb', '#14b8a6'],
    series: [
      {
        name: seriesNames?.[0] ?? 'Current',
        type: 'line',
        smooth: true,
        symbolSize: px(7),
        areaStyle: { color: 'rgba(37,99,235,.08)' },
        data: data.map((item) => item.value),
      },
      {
        name: seriesNames?.[1] ?? 'Previous',
        type: 'line',
        smooth: true,
        symbolSize: px(6),
        data: data.map((item) => item.secondary),
      },
    ],
  };
}

export function EChart({
  kind,
  data,
  className = 'h-72',
  seriesNames,
  funnelMode = 'proportional',
  series,
  stacked,
  funnelStages,
  funnelLabels,
  colors,
}: {
  kind: ChartKind;
  data: Datum[];
  className?: string;
  seriesNames?: SeriesNames;
  funnelMode?: FunnelMode;
  /** Bar/line only: replaces value/secondary with any number of named series over `data` names. */
  series?: ChartSeries[];
  stacked?: boolean;
  /** Funnel only: how many stages to draw (default 5). */
  funnelStages?: number;
  /** Staged funnel only: where the stage names and counts go (default inside the bands). */
  funnelLabels?: FunnelLabels;
  /** Bar/line with `series` only: one colour per series, in series order. */
  colors?: string[];
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    let chart: echarts.ECharts | undefined;
    let renderedScale = Number.NaN;

    /**
     * ECharts converts the pointer from `getBoundingClientRect` -- physical
     * pixels -- into its own coordinate space without accounting for CSS zoom,
     * so under the fixed canvas it read every hover short by the zoom factor:
     * hovering 27 Aug reported 25 Aug, and the tooltip drifted further from the
     * cursor the further right you moved.
     *
     * Undoing the zoom on the chart and sizing it in physical pixels makes
     * those two spaces the same one again. The frame around it keeps the
     * layout size, so the chart still occupies exactly the space it did.
     */
    const render = () => {
      const zoom = readCanvasZoom();
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      if (!width || !height) return;
      canvas.style.zoom = zoom === 1 ? '' : String(1 / zoom);
      canvas.style.width = `${Math.round(width * zoom)}px`;
      canvas.style.height = `${Math.round(height * zoom)}px`;
      chart ??= echarts.init(canvas, undefined, { renderer: 'svg' });
      if (renderedScale !== zoom) {
        chart.setOption(
          optionFor(kind, data, seriesNames, funnelMode, zoom, {
            series,
            stacked,
            funnelStages,
            funnelLabels,
            colors,
          }),
          true,
        );
        renderedScale = zoom;
      }
      chart.resize();
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(frame);
    // A zoom change moves no layout box, so the observer alone would miss it.
    window.addEventListener(CANVAS_ZOOM_CHANGED_EVENT, render);
    return () => {
      observer.disconnect();
      window.removeEventListener(CANVAS_ZOOM_CHANGED_EVENT, render);
      chart?.dispose();
    };
  }, [funnelMode, kind, data, seriesNames, series, stacked, funnelStages, funnelLabels, colors]);
  return (
    <div ref={frameRef} className={className} role="img" aria-label={`${kind} chart`}>
      <div ref={canvasRef} />
    </div>
  );
}
