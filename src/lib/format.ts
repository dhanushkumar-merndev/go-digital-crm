/**
 * How the CRM writes numbers, money, dates and enum values on screen. Every
 * role reads the same dealership, so a booking value or a case status must not
 * be "₹2,18,000" on one page, "218000" on another and "Updated Desc" on a third.
 */

export { formatCurrency, formatNumber } from './utils';

const timeZone = 'Asia/Kolkata';

// Words that stay upper case when an enum is turned into a label.
const acronyms = new Set([
  'AI',
  'API',
  'CPL',
  'CRM',
  'GST',
  'GSTIN',
  'ID',
  'IVR',
  'KM',
  'KPI',
  'MFA',
  'OEM',
  'PAN',
  'PDI',
  'RC',
  'ROI',
  'RTO',
  'SLA',
  'SMS',
  'URL',
  'VIN',
]);

const special: Record<string, string> = { WHATSAPP: 'WhatsApp' };

/**
 * `IN_PROGRESS` → "In progress", `NOT_REQUESTED` → "Not requested",
 * `RTO_PENDING` → "RTO pending". Sentence case, like every other label. A value
 * that already carries lower-case letters is a label someone wrote, so it is
 * returned unchanged.
 */
export function humanizeEnum(value: string | null | undefined) {
  if (!value) return '';
  if (/[a-z]/.test(value)) return value;
  return value
    .split(/[_\s:]+/)
    .filter(Boolean)
    .map((word, index) => {
      if (special[word]) return special[word];
      if (acronyms.has(word)) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** ₹2.18 Cr / ₹4.5 L / ₹85,000 — the crore-lakh grouping owners read. */
export function formatCompactCurrency(value: number) {
  if (Math.abs(value) >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`;
  if (Math.abs(value) >= 1e5) return `₹${(value / 1e5).toFixed(1)} L`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

export function formatPercent(value: number, digits = 1) {
  return `${Number.isFinite(value) ? value.toFixed(digits).replace(/\.0+$/, '') : '0'}%`;
}

function toDate(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 21 Oct 2026 */
export function formatDate(value: string | number | Date | null | undefined) {
  const date = value == null ? null : toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone }).format(date)
    : '—';
}

/** 21 Oct 2026, 1:47 pm */
export function formatDateTime(value: string | number | Date | null | undefined) {
  const date = value == null ? null : toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(date)
    : '—';
}

/** 21 Oct — for chart axes and compact cells, never a raw MM-DD. */
export function formatDayMonth(value: string | number | Date | null | undefined) {
  const date = value == null ? null : toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone }).format(date)
    : '—';
}

const sortLabels: Record<string, string> = {
  'updated:desc': 'Recently updated',
  'updated:asc': 'Least recently updated',
  'created:desc': 'Newest first',
  'created:asc': 'Oldest first',
  'due:asc': 'Due soonest',
  'sla:asc': 'SLA soonest',
  'customer:asc': 'Customer A–Z',
  'name:asc': 'Name A–Z',
  'status:asc': 'Status',
  'priority:desc': 'Highest priority',
  'severity:desc': 'Highest severity',
};

/** A sort option the way a person says it: "Newest first", not "Created Desc". */
export function sortLabel(sort: string) {
  return sortLabels[sort.replace('-', ':')] ?? humanizeEnum(sort.toUpperCase());
}
