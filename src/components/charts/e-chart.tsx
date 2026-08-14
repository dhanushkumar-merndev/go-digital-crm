'use client';

import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';
import type { ChartKind } from '@/lib/domain';

type Datum = { name: string; value: number; secondary?: number };

function optionFor(kind: ChartKind, data: Datum[]): echarts.EChartsCoreOption {
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
  if (kind === 'funnel')
    return {
      tooltip: { trigger: 'item' },
      color: ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd'],
      series: [
        {
          type: 'funnel',
          top: 8,
          bottom: 8,
          left: '6%',
          width: '88%',
          minSize: '25%',
          maxSize: '100%',
          sort: 'descending',
          gap: 3,
          label: { color: '#fff', fontSize: 11 },
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          data: data
            .slice(0, 5)
            .map((item, index) => ({ ...item, value: Math.max(12, 96 - index * 17) })),
        },
      ],
    };
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
          name: 'Actual',
          type: 'bar',
          barMaxWidth: 22,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: data.map((item) => item.value),
        },
        {
          name: 'Target',
          type: 'bar',
          barMaxWidth: 22,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
          data: data.map((item) => item.secondary),
        },
      ],
    };
  return {
    ...common,
    color: ['#2563eb', '#14b8a6'],
    series: [
      {
        name: 'Current',
        type: 'line',
        smooth: true,
        symbolSize: 7,
        areaStyle: { color: 'rgba(37,99,235,.08)' },
        data: data.map((item) => item.value),
      },
      {
        name: 'Previous',
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
}: {
  kind: ChartKind;
  data: Datum[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    chart.setOption(optionFor(kind, data));
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [kind, data]);
  return <div ref={ref} className={className} role="img" aria-label={`${kind} chart`} />;
}
