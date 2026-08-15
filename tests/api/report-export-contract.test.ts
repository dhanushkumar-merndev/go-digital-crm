import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('report export boundary', () => {
  it('uses a scoped, audited job and service-only worker claims', async () => {
    const sql = await readFile(
      `${root}/supabase/migrations/202608150031_report_exports.sql`,
      'utf8',
    );
    expect(sql).toContain("('report.view', 'reports'");
    expect(sql).toContain("('report.export', 'reports'");
    expect(sql).toContain('create table public.report_exports');
    expect(sql).toContain('create or replace function public.request_report_export');
    expect(sql).toContain("message = 'ORGANIZATION_SCOPE_REQUIRED'");
    expect(sql).toContain("'report.export_requested'");
    expect(sql).toContain('create or replace function public.claim_report_exports');
    expect(sql).toContain("auth.role() <> 'service_role'");
    expect(sql).toContain("'READY'");
    expect(sql).toContain('create or replace function public.authorize_report_export_download');
  });

  it('keeps generated output aggregate-only, private, leased and bounded', async () => {
    const [worker, download] = await Promise.all([
      readFile(`${root}/trigger/report-export.ts`, 'utf8'),
      readFile(`${root}/supabase/functions/presign-download/index.ts`, 'utf8'),
    ]);
    expect(worker).toContain("id: 'report-export'");
    expect(worker).toContain("pattern: '*/5 * * * *'");
    expect(worker).toContain("'get_report_export_payload'");
    expect(worker).toContain("resource_type: 'report_export'");
    expect(worker).toContain('5 * 1024 * 1024');
    expect(worker).toContain("'complete_report_export'");
    expect(worker).toContain("'retry_report_export'");
    expect(download).toContain("file.resource_type === 'report_export'");
    expect(download).toContain("'authorize_report_export_download'");
  });
});
