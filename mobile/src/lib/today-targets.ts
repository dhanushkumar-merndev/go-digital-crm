import { supabase } from './supabase';

export type TodayTarget = { key: string; label: string; done: number; target: number };

const labels: Record<string, string> = {
  leads: 'Leads',
  calls: 'Calls',
  connected_calls: 'Connected',
  contacted: 'Contacted',
  qualified: 'Qualified',
  transferred: 'Transferred',
  followups_completed: 'Follow-ups',
  appointments: 'Appointments',
  test_drives: 'Test drives',
  bookings: 'Bookings',
};

// The order the reference reads them in: work in, then the outcomes.
const order = Object.keys(labels);

/**
 * Today's progress against the targets a manager set for this user. Only
 * metrics with a target come back, so nothing is drawn against a made-up goal;
 * a user with no targets gets an empty list and the card stays hidden.
 */
export async function fetchTodayTargets(role: 'telecaller' | 'sales'): Promise<TodayTarget[]> {
  const { data, error } = await supabase.rpc(
    role === 'telecaller' ? 'get_telecaller_performance' : 'get_sales_consultant_performance',
    { target_days: 1, target_timezone: 'Asia/Kolkata' },
  );
  if (error) throw error;
  const result = (data ?? {}) as {
    kpis?: Record<string, unknown>;
    targets?: Record<string, unknown>;
  };
  const kpis = result.kpis ?? {};
  return Object.entries(result.targets ?? {})
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      done: Number(kpis[key] ?? 0) || 0,
      target: Number(value) || 0,
    }))
    .filter((item) => item.target > 0 && labels[item.key])
    .sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
    .slice(0, 4);
}
