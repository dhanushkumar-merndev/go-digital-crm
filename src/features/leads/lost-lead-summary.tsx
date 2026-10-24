'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CircleOff, History, Swords } from 'lucide-react';
import { z } from 'zod';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { SectionCard } from '@/components/shared/section-card';
import { formatNumber } from '@/lib/format';
import type { Metric } from '@/lib/domain';
import { createClient } from '@/lib/supabase/client';

const lostLeadSummarySchema = z.object({
  generated_at: z.string(),
  total: z.coerce.number().int().nonnegative(),
  this_month: z.coerce.number().int().nonnegative(),
  last_7_days: z.coerce.number().int().nonnegative(),
  competitor: z.coerce.number().int().nonnegative(),
  reasons: z.array(z.object({ name: z.string(), value: z.coerce.number().int().nonnegative() })),
});

async function fetchLostLeadSummary(signal: AbortSignal) {
  const request = createClient().rpc('get_lost_lead_summary', {
    target_timezone: 'Asia/Kolkata',
  });
  const { data, error } = await request.abortSignal(signal);
  if (error) throw error;
  return lostLeadSummarySchema.parse(data);
}

/** The eight largest reasons by name; the rest share one slice so the donut stays readable. */
function reasonSlices(reasons: z.infer<typeof lostLeadSummarySchema>['reasons']) {
  if (reasons.length <= 8) return reasons;
  const rest = reasons.slice(7).reduce((sum, reason) => sum + reason.value, 0);
  return [...reasons.slice(0, 7), { name: 'Other reasons', value: rest }];
}

const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/**
 * The Lost Leads page's summary (PRD 54.3 §33-34): how many leads in scope are
 * lost, how recently, and why. The list below it already filters to Lost, so
 * this adds only what a row-by-row list cannot show. It stays out of the way
 * when the summary function is not available.
 */
export function LostLeadSummary() {
  const session = useWorkspaceSession();
  const query = useQuery({
    queryKey: ['lost-lead-summary', ...workspaceQueryScope(session)],
    queryFn: ({ signal }) => fetchLostLeadSummary(signal),
  });
  if (!query.data) return null;
  const data = query.data;
  const metrics: Metric[] = [
    {
      label: 'Lost leads',
      value: formatNumber(data.total),
      helper: 'In your scope, all time',
      icon: CircleOff,
      tone: 'bg-slate-100 text-slate-600',
    },
    {
      label: 'Lost this month',
      value: formatNumber(data.this_month),
      helper: `${share(data.this_month, data.total)}% of all lost`,
      icon: CalendarClock,
      tone: 'bg-orange-50 text-orange-600',
    },
    {
      label: 'Last 7 days',
      value: formatNumber(data.last_7_days),
      helper: 'Marked lost this week',
      icon: History,
      tone: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Lost to a competitor',
      value: formatNumber(data.competitor),
      helper: `${share(data.competitor, data.total)}% of all lost`,
      icon: Swords,
      tone: 'bg-rose-50 text-rose-600',
    },
  ];
  const slices = reasonSlices(data.reasons);

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <div className="xl:col-span-7">
        <KpiGrid metrics={metrics} className="xl:grid-cols-2" />
      </div>
      <SectionCard
        title="Why leads were lost"
        description="Reason recorded when each lead was closed"
        className="xl:col-span-5"
      >
        {slices.length ? (
          <EChart kind="donut" data={slices} className="h-56" />
        ) : (
          <p className="grid h-56 place-items-center text-sm text-muted-foreground">
            No lost leads in your scope.
          </p>
        )}
      </SectionCard>
    </div>
  );
}
