import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leadTemperatureFilters } from '../../src/features/leads/lead-workspace-query';

const read = (path: string) => readFileSync(path, 'utf8');
const enumMigration = read('supabase/migrations/202609020009_add_dormant_lead_temperature.sql');
const guardMigration = read(
  'supabase/migrations/202609020010_suppress_dormant_drip_enrollment.sql',
);
const agents = read('AGENTS.md');

// Every file that parses or renders a lead's temperature. A value that exists in
// the database but is missing from one of these fails the zod parse and blanks
// the workspace for every row carrying it, so the list is asserted as a set
// rather than left to whoever adds the next enum value to remember.
const temperatureConsumers = [
  'src/features/dashboards/tenant-dashboard-api.ts',
  'src/features/dashboards/sales-consultant-dashboard-api.ts',
  'src/features/leads/lead-detail-api.ts',
  'src/features/leads/lead-workspace-api.ts',
  'src/features/leads/lead-workspace.tsx',
  'mobile/src/components/mobile-lead-list-screen.tsx',
  'mobile/src/lib/customer-detail.ts',
  'mobile/src/lib/lead-detail.ts',
  'mobile/src/lib/sales-dashboard.ts',
  'mobile/src/lib/telecaller-dashboard.ts',
];

describe('DORMANT lead temperature', () => {
  it('adds the enum value on its own, with nothing using it', () => {
    // Postgres refuses to use a new enum label in the transaction that adds it,
    // so the guard comparing against 'DORMANT' has to be a separate migration.
    expect(enumMigration).toContain(
      "alter type public.lead_temperature add value if not exists 'DORMANT';",
    );
    expect(enumMigration).not.toContain('create or replace function');
    expect(guardMigration).toContain("= 'DORMANT'");
  });

  it('is accepted by the write path, not just the enum', () => {
    // update_lead validates the patch against its own hardcoded tuple before
    // casting, so adding the enum value alone left every "Set DORMANT" raising
    // INVALID_LEAD_TEMPERATURE. The enum and this list have to move together.
    expect(read('supabase/migrations/202609020011_allow_dormant_in_update_lead.sql')).toContain(
      "not in ('COLD', 'WARM', 'HOT', 'DORMANT')",
    );
  });

  it('suppresses drip enrollment on the table, not in one RPC', () => {
    // Enforced by trigger so it holds for a future dispatcher or import too.
    expect(guardMigration).toContain(
      'create trigger reject_dormant_drip_enrollment\nbefore insert on public.customer_drip_enrollments',
    );
    expect(guardMigration).toContain("message = 'LEAD_IS_DORMANT'");
    expect(guardMigration).toContain(
      'revoke all on function app_private.reject_dormant_drip_enrollment()',
    );
  });

  it('is parseable and renderable everywhere a temperature reaches the client', () => {
    const missing = temperatureConsumers.filter((file) => !read(file).includes('DORMANT'));
    expect(missing).toEqual([]);
  });

  it('is selectable as a filter and settable from the lead workspace', () => {
    expect(leadTemperatureFilters).toContain('DORMANT');
    expect(read('src/features/leads/lead-workspace.tsx')).toContain(
      "const temperatureOptions = ['COLD', 'WARM', 'HOT', 'DORMANT'] as const;",
    );
    expect(read('src/features/leads/lead-workspace.tsx')).toContain(
      'temperatureOptions.map((temperature)',
    );
    expect(
      read('supabase/migrations/202609020017_allow_dormant_lead_workspace_filter.sql'),
    ).toContain("(''all'', ''HOT'', ''WARM'', ''COLD'', ''DORMANT'')");
  });

  it('does not render as an ordinary cold lead', () => {
    // Sharing COLD's styling would hide the suppression from anyone scanning
    // the column, which is the one thing the value exists to communicate.
    for (const file of [
      'src/features/dashboards/telecaller-dashboard.tsx',
      'src/features/dashboards/tenant-dashboard.tsx',
      'src/features/dashboards/sales-consultant-dashboard.tsx',
      'src/features/leads/lead-assignment-workspace.tsx',
      'src/features/leads/lead-workspace.tsx',
    ])
      expect(read(file)).toMatch(
        /DORMANT'\s*\n?\s*\??\s*'secondary'|'DORMANT'\) return 'secondary'/,
      );
  });

  it('writes the messaging policy down where agents will read it', () => {
    expect(agents).toContain('### 9.7 Lead temperature and outbound messaging priority');
    expect(agents).toContain('`HOT` first, then `WARM`, then `COLD`');
    expect(agents).toContain('hard suppression, not a low priority');
    expect(agents).toContain('LEAD_IS_DORMANT');
    // Suppression is marketing-only; one-to-one and transactional contact stays.
    expect(agents).toContain('are not marketing and are not\nsuppressed');
    expect(agents).toContain('Nothing automatically sets or clears `DORMANT`');
  });
});
