export type PerformanceDateRange = {
  from: string;
  to: string;
};

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function performanceToday() {
  return formatDate(new Date());
}

export function performanceRangeForLastDays(days: number): PerformanceDateRange {
  const to = performanceToday();
  const [year, month, day] = to.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return { from: start.toISOString().slice(0, 10), to };
}

export function performanceRangeDays(range: PerformanceDateRange) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

export function performanceRangeLabel(range: PerformanceDateRange) {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  const from = new Date(`${range.from}T00:00:00Z`).toLocaleDateString('en-IN', options);
  const to = new Date(`${range.to}T00:00:00Z`).toLocaleDateString('en-IN', options);
  return `${from} – ${to}`;
}

/**
 * Performance RPCs use the selected end date to make historical ranges exact
 * while retaining a fixed operating timezone for all tenant reporting.
 */
export function performanceRpcTimezone(range: PerformanceDateRange) {
  return `Asia/Kolkata|${range.to}`;
}
