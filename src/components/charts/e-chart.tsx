'use client';

import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';
import type { ChartKind } from '@/lib/domain';

type Datum = { name: string; value: number; secondary?: number };
type SeriesNames = [string, string];
type FunnelMode = 'proportional' | 'staged';

function optionFor(
  kind: ChartKind,
  data: Datum[],
  seriesNames?: SeriesNames,
  funnelMode: FunnelMode = 'proportional',
): echarts.EChartsCoreOption {
  const text = '#667085';
  const grid = { left: 42, right: 20, top: 20, bottom: 32 };
  if (kind === 'donut')
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: text } },
      color: ['#2563eb', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444'],
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
    const funnelData =
      funnelMode === 'staged'
        ? data.slice(0, 5).map((item, index, items) => ({
            name: `${item.name}   ${item.value}`,
            value: items.length - index,
          }))
        : data.slice(0, 5);
    return {
      tooltip: { trigger: 'item', formatter: funnelMode === 'staged' ? '{b}' : undefined },
      color:
        funnelMode === 'staged'
          ? ['#1769e8', '#58a4e8', '#18b8bd', '#8b5de7', '#55c58a']
          : ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd'],
      series: [
        {
          type: 'funnel',
          top: 4,
          bottom: 4,
          left: '2%',
          width: '96%',
          min: funnelMode === 'staged' ? 1 : undefined,
          max: funnelMode === 'staged' ? Math.max(funnelData.length, 1) : undefined,
          minSize: funnelMode === 'staged' ? '34%' : '25%',
          maxSize: '100%',
          sort: funnelMode === 'staged' ? 'none' : 'descending',
          funnelAlign: 'center',
          gap: 2,
          label: { color: '#fff', fontSize: 11, fontWeight: 500 },
          labelLine: { show: false },
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          emphasis: { label: { fontSize: 11 } },
          data: funnelData,
        },
      ],
    };
  }
  const common = {
    tooltip: { trigger: 'axis' },
    grid,
    legend: { top: 0, right: 0, textStyle: { color: text } },
    xAxis: {
      type: 'category' as const,
      data: data.map((item) => item.name),
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
      axisLabel: { color: text },
    },
    yAxis: {
      type: 'value' as const,
      splitLine: { lineStyle: { color: '#eef1f5' } },
      axisLabel: { color: text },
    },
  };
  if (kind === 'bar')
    return {
      ...common,
      color: ['#2563eb', '#bfdbfe'],
      series: [
        {
          name: seriesNames?.[0] ?? 'Actual',
          type: 'bar',
          barMaxWidth: 22,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: data.map((item) => item.value),
        },
        ...(data.some((item) => item.secondary !== undefined)
          ? [
              {
                name: seriesNames?.[1] ?? 'Target',
                type: 'bar' as const,
                barMaxWidth: 22,
                itemStyle: { borderRadius: [4, 4, 0, 0] },
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
        symbolSize: 7,
        areaStyle: { color: 'rgba(37,99,235,.08)' },
        data: data.map((item) => item.value),
      },
      {
        name: seriesNames?.[1] ?? 'Previous',
        type: 'line',
        smooth: true,
        symbolSize: 6,
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
}: {
  kind: ChartKind;
  data: Datum[];
  className?: string;
  seriesNames?: SeriesNames;
  funnelMode?: FunnelMode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    chart.setOption(optionFor(kind, data, seriesNames, funnelMode));
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [funnelMode, kind, data, seriesNames]);
  return <div ref={ref} className={className} role="img" aria-label={`${kind} chart`} />;
}
