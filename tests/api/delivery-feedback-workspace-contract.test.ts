import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../../supabase/migrations/202608220044_delivery_feedback_workspace.sql',
  import.meta.url,
);

describe('delivery feedback workspace contract', () => {
  it('keeps feedback anchored to one delivered case and exposes bounded server pagination', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('delivery_case_id uuid');
    expect(sql).toContain('feedback_requests_delivery_case_unique_idx');
    expect(sql).toContain(
      'create or replace function public.get_delivery_feedback_workspace_page(',
    );
    expect(sql).toContain(
      "normalized_status not in ('ALL', 'NOT_REQUESTED', 'PENDING', 'COMPLETED')",
    );
    expect(sql).toContain('target_page_size not in (25, 50, 100)');
    expect(sql).toContain("delivery_row.status = 'DELIVERED'");
    expect(sql).toContain('app_private.can_access_record(');
    expect(sql).toContain('app_private.can_access_customer(');
  });

  it('makes manual follow-up and response capture idempotent, scoped and audited', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('create or replace function public.request_delivery_feedback(');
    expect(sql).toContain('create or replace function public.capture_delivery_feedback(');
    expect(sql).toContain("app_private.has_permission(current_organization_id, 'delivery.manage')");
    expect(sql).toContain('app_private.replay_operational_case_request(');
    expect(sql).toContain("'case.delivery_feedback.requested'");
    expect(sql).toContain("'case.delivery_feedback.captured'");
    expect(sql).toContain("'DELIVERY_FEEDBACK_REQUEST_REQUIRED'");
    expect(sql).toContain("status = 'COMPLETED'");
  });
});
