import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/202610171811_lead_requirements_interested_model.sql');

describe('interested model edited with the lead requirements', () => {
  it('patches the live function instead of re-emitting an older body', () => {
    expect(migration).not.toMatch(/create or replace function public\.update_lead_requirements/i);
    expect(migration.match(/select pg_temp\.patch_function\(/g)).toHaveLength(4);
    expect(migration).toContain("'public.update_lead_requirements(uuid,bigint,jsonb,uuid)'");
  });

  it('changes the lead model only when the key is sent, trimmed and capped', () => {
    expect(migration).toContain("if target_payload ? 'interested_model' then");
    expect(migration).toContain(
      "nullif(left(btrim(coalesce(target_payload->>'interested_model', '')), 160), '')",
    );
    expect(migration).toContain('if next_model is distinct from lead_row.interested_model then');
  });

  it('writes what changed to the timeline activity and the audit row', () => {
    expect(migration).toContain(
      "jsonb_strip_nulls(jsonb_build_object('version', next_version, 'summary', change_summary))",
    );
    expect(migration).toContain("'after', after_json,");
    // get_lead_journey shows metadata.summary as the event detail.
    expect(read('supabase/migrations/202610090491_lead_journey.sql')).toContain(
      "nullif(activity_row.metadata->>'summary', '')",
    );
  });

  it('edits the model from the requirements sheet with the shared picker', () => {
    const panel = read('src/features/leads/lead-requirements-panel.tsx');
    expect(panel).toContain('<InterestedModelPicker');
    expect(panel).toContain('interested_model: model.trim() || null');
    expect(read('src/features/leads/lead-workspace.tsx')).toContain('<InterestedModelPicker');
    const detail = read('src/features/leads/lead-detail-workspace.tsx');
    expect(detail).toContain('branchId={lead.branch_id}');
    expect(detail).toContain("queryClient.invalidateQueries({ queryKey: ['lead-journey'] })");
  });
});
