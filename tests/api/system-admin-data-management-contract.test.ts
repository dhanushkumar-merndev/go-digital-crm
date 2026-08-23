import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const exportMigration = source('supabase/migrations/202608150031_report_exports.sql');
const workspace = source('src/features/reports/report-export-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('system administrator data management contract', () => {
  it('uses the existing audited export workflow instead of claiming unverified backup or restore capability', () => {
    expect(exportMigration).toContain("'system_administrator'");
    expect(exportMigration).toContain('report.export_requested');
    expect(exportMigration).toContain("expires_at = now() + interval '30 days'");
    expect(workspace).toContain('Aggregate exports only');
    expect(workspace).not.toMatch(/restore\s+database|run\s+full\s+backup/i);
  });

  it('routes Backup & Data Management before the production fallback', () => {
    expect(route).toContain("role === 'system-administrator' && slug[0] === 'backup-data'");
    expect(route.indexOf('<ReportExportWorkspace spec={spec} />')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
