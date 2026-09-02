import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609020016_phone_group_prefers_open_lead.sql',
  'utf8',
);
const grouping = readFileSync('supabase/migrations/202609020001_group_leads_by_phone.sql', 'utf8');

describe('phone group represented by a lead still being worked', () => {
  it('was recency-only before, which is the behaviour being corrected', () => {
    // If 202609020001 ever grows its own ranking, this migration is patching
    // something that no longer exists and must be revisited.
    expect(grouping).toContain('lead_row.created_at desc');
    expect(grouping).not.toContain('actor_is_sales_consultant then 1');
    expect(grouping).not.toContain("lifecycle_status = ''Lost'' then 2");
  });

  it('ranks finished leads below open ones, newest-first only within a rank', () => {
    expect(migration).toContain("when lead_row.lifecycle_status = ''Lost'' then 2");
    expect(migration).toContain("when lead_row.lifecycle_status = ''Transferred to Sales''");
    expect(migration).toContain('else 0');
    // Recency still decides between two leads of equal standing.
    expect(migration).toContain('lead_row.created_at desc');
  });

  it('only demotes Transferred to Sales for the roles it is terminal for', () => {
    // It ends the Telecaller's job and starts the Sales Consultant's, so
    // demoting it for a consultant would bury their own active work.
    expect(migration).toContain('and not actor_is_sales_consultant then 1');
  });

  it('carries lifecycle_status far enough down the query to rank on it', () => {
    expect(migration).toContain('from staged_leads lead_row');
    expect(migration).toContain('lead_row.lifecycle_status');
  });

  it('refuses to apply if it cannot find what it is patching', () => {
    // A text patch against pg_get_functiondef silently does nothing when the
    // target has moved, which would leave the ordering unchanged and unnoticed.
    expect(migration).toContain('PHONE_GROUP_OPEN_LEAD_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain('if updated_definition = definition');
    expect(migration).toContain('execute updated_definition;');
  });
});
