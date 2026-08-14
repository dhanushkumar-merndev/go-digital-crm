import type { PageQuery, PageResult, PageRow, PageSpec } from '@/lib/domain';

const values: Record<string, string[]> = {
  customer: [
    'Aarav Sharma',
    'Diya Patel',
    'Kabir Singh',
    'Meera Iyer',
    'Vihaan Rao',
    'Ananya Gupta',
  ],
  owner: ['Priya Nair', 'Rohan Das', 'Neha Kapoor', 'Vikram Shah', 'Arjun Menon'],
  stage: ['New', 'Contacted', 'Qualified', 'In progress', 'Completed'],
  workState: ['NEW_TODAY', 'PENDING', 'SLA_RISK'],
  source: ['Facebook', 'Google Ads', 'Website', 'WhatsApp Business', 'CarWale', 'Manual'],
  model: [
    'Nexon EV · Empowered+',
    'Harrier · Fearless',
    'Safari · Accomplished',
    'Punch · Creative+',
    'Curvv · Accomplished',
  ],
  branch: ['MG Road', 'Whitefield', 'HSR Layout', 'Electronic City'],
  team: ['Velocity', 'Apex', 'Momentum', 'Pioneer'],
  method: ['Round Robin', 'Manual Assignment'],
  direction: ['Outbound', 'Inbound'],
  outcome: ['Connected', 'No answer', 'Follow-up', 'Interested'],
  recording: ['Available', 'Sync pending', 'Manual upload'],
  priority: ['High', 'Medium', 'Normal'],
  appointmentType: ['Showroom visit', 'Consultation', 'Test drive'],
  route: ['Completed · 8.4 km', 'Scheduled', 'Active'],
  role: ['Sales Consultant', 'Telecaller / BDC', 'Team Manager', 'Finance Executive'],
  mfa: ['Enabled', 'Required', 'Optional'],
  module: ['Leads', 'Calls', 'Customers', 'Bookings'],
  permissions: ['View · Create · Update', 'View only', 'View · Manage'],
  scope: ['OWN_RECORDS', 'OWN_TEAM', 'ONE_BRANCH', 'SELECTED_BRANCHES', 'ALL_BRANCHES'],
  provider: ['Meta Lead Ads', 'WhatsApp Business', 'Google Ads', 'IVR Connect', 'Brevo'],
  health: ['Healthy', 'Healthy', 'Needs attention'],
  action: ['Updated', 'Created', 'Assigned', 'Approved'],
  resource: ['Lead', 'User', 'Booking', 'Integration'],
  category: ['Sales', 'Operations', 'Security', 'Administration'],
  report: ['Sales conversion', 'Lead source ROI', 'Booking pipeline', 'Team performance'],
};

function valueFor(key: string, index: number): string | number {
  const pool = values[key];
  if (pool) return pool[index % pool.length] ?? '';
  const suffix = String(index + 1).padStart(4, '0');
  const presets: Record<string, string | number> = {
    reference: `GDM-${suffix}`,
    phone: `+91 98${String(73100000 + index).slice(-8)}`,
    updated: `${(index % 12) + 1} min ago`,
    scheduled: `14 Aug · ${10 + (index % 8)}:30`,
    amount: `₹${(8.4 + (index % 13) * 0.72).toFixed(2)} L`,
    version: `v${(index % 3) + 1}`,
    registration: `KA-01-M${2200 + index}`,
    email: `user${index + 1}@dealership.in`,
    employeeId: `EMP-${suffix}`,
    members: 4 + (index % 8),
    teams: 2 + (index % 4),
    workload: 8 + (index % 19),
    queue: index % 2 ? 'Qualified sales' : 'Fresh lead',
    reason: index % 2 ? 'Price discussion' : 'Test-drive confirmation',
    duration: `0${2 + (index % 6)}:${String(12 + index).slice(-2)}`,
    vin: `MAT627${String(980000 + index)}`,
    color: index % 2 ? 'Daytona Grey' : 'Pristine White',
    age: `${8 + (index % 84)} days`,
    allocation: index % 3 ? 'Available' : 'Allocated',
    booking: `BKG-${suffix}`,
    documents: `${2 + (index % 5)} / 6`,
    connection: `Branch account ${1 + (index % 3)}`,
    lastSync: `${2 + (index % 40)} min ago`,
    records: 120 + index * 7,
    code: `BR-${String(index + 1).padStart(2, '0')}`,
    location: index % 2 ? 'Bengaluru, Karnataka' : 'Mysuru, Karnataka',
    campaign: `August Drive ${1 + (index % 5)}`,
    leads: 24 + (index % 40),
    qualified: 8 + (index % 18),
    testDrives: 4 + (index % 12),
    bookings: 2 + (index % 8),
    conversion: `${18 + (index % 24)}%`,
    target: `${72 + (index % 28)}%`,
    spend: `₹${22 + index}K`,
    period: '01–14 Aug 2026',
    feature: index % 2 ? 'AI call summary' : 'Live tracking',
    service: index % 2 ? 'Supabase' : 'Trigger.dev',
    latency: `${72 + (index % 90)} ms`,
    errors: index % 7,
    lastCheck: 'Just now',
    name: `Configuration ${index + 1}`,
    value: index % 2 ? 'Enabled' : 'Configured',
    approver: 'Showroom Manager',
    purpose: 'Investigate provider synchronization',
    expires: '48 min',
  };
  return presets[key] ?? `Value ${index + 1}`;
}

function makeRows(spec: PageSpec): PageRow[] {
  return Array.from({ length: 67 }, (_, index) => {
    const row: PageRow = { id: `${spec.category}-${index + 1}` };
    for (const column of spec.columns) row[column.key] = valueFor(column.key, index);
    return row;
  });
}

export async function fetchPageData(
  spec: PageSpec,
  query: PageQuery,
  signal?: AbortSignal,
): Promise<PageResult> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 220);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Request cancelled', 'AbortError'));
    });
  });
  let rows = makeRows(spec);
  if (query.search.trim()) {
    const term = query.search.trim().toLocaleLowerCase();
    rows = rows.filter((row) =>
      Object.values(row).some((value) => String(value).toLocaleLowerCase().includes(term)),
    );
  }
  if (query.status !== 'all') {
    rows = rows.filter(
      (row) =>
        String(row.stage ?? row.workState ?? '')
          .toLocaleLowerCase()
          .replaceAll(' ', '-') === query.status,
    );
  }
  const total = rows.length;
  const start = (query.page - 1) * query.pageSize;
  const chart = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, index) => ({
    name,
    value: 32 + ((index * 17 + spec.title.length) % 42),
    secondary: 18 + ((index * 11 + spec.category.length) % 27),
  }));
  return { rows: rows.slice(start, start + query.pageSize), total, chart };
}
