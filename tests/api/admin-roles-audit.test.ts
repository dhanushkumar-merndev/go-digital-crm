import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const route = source('src/app/[role]/[[...slug]]/page.tsx');
const platformReports = source('src/features/platform/platform-reports-workspace.tsx');
const tenantReports = source('src/features/reports/report-export-workspace.tsx');
const pageSpecs = source('src/config/page-specs.ts');
const adminDashboard = source('src/features/administration/admin-dashboard.tsx');

describe('Super Admin reports', () => {
  it('read platform aggregates instead of the tenant export queue', () => {
    expect(route).toContain(
      "if (role === 'super-admin' && slug[0] === 'reports' && !isLocalPreviewMode())",
    );
    for (const fetcher of [
      'fetchPlatformDashboard(',
      'fetchPlatformAiUsage(',
      'fetchPlatformModuleWorkspace(',
      'fetchPlatformIntegrationWorkspace(',
    ])
      expect(platformReports).toContain(fetcher);
    expect(platformReports).not.toContain('get_report_exports_page');
  });

  it('fail with the standard error state on tenant reports', () => {
    expect(tenantReports).not.toContain('Reports could not be loaded. Refresh and try again.');
    expect(tenantReports).toContain('title="Reports are unavailable"');
  });
});

describe('page descriptions', () => {
  it('give each role its own dashboard sentence', () => {
    expect(pageSpecs).toContain('const dashboardDescriptions: Partial<Record<RoleKey, string>>');
    expect(pageSpecs).toContain("(slug === 'dashboard' ? dashboardDescriptions[role] : undefined)");
  });

  it('replace the configuration placeholder on the pages that fell back to it', () => {
    for (const slug of [
      'reviews:',
      "'master-data':",
      "'onboarding-reviews':",
      "'complaints-escalations':",
      "'ai-business-summary':",
    ])
      expect(pageSpecs).toContain(slug);
  });
});

describe('Client Admin dashboard', () => {
  it('groups roles into the PRD hierarchy for the users-by-role donut', () => {
    expect(adminDashboard).toContain('data={roleGroups(data.roles)}');
    expect(adminDashboard).toContain("'Operational users'");
  });
});
