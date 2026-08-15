import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202608150030_marketing_workspace.sql'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('marketing workspace tenant foundation', () => {
  it('separates visibility, campaign management and social-draft authority', () => {
    expect(migration).toContain("('marketing.view', 'marketing'");
    expect(migration).toContain("('marketing.manage', 'marketing'");
    expect(migration).toContain("('marketing.social.manage', 'marketing'");
    expect(migration).toContain("role_row.role_key = 'digital_marketing_manager'");
    expect(migration).toContain('roles_apply_default_marketing_permissions');
  });

  it('uses tenant composite foreign keys and controlled retention for campaigns and posts', () => {
    for (const key of [
      'marketing_campaign_branch_org_fk',
      'marketing_campaign_account_org_fk',
      'social_post_branch_org_fk',
      'social_post_account_org_fk',
      'social_post_campaign_org_fk',
    ]) {
      expect(migration).toContain(`constraint ${key}`);
      expect(migration).toContain(`validate constraint ${key}`);
    }
    expect(migration).toContain("('social_posts', 'DELETE', 785)");
    expect(migration).toContain("('marketing_campaigns', 'DELETE', 786)");
  });

  it('keeps source reporting server-side, scoped, bounded and honest about costs', () => {
    const page = section(
      'create or replace function public.get_marketing_workspace_page(',
      'alter table public.marketing_campaigns enable row level security',
    );
    expect(page).toContain("normalized_view not in ('SOURCES', 'CAMPAIGNS', 'SOCIAL_POSTS')");
    expect(page).toContain('target_page_size not in (25, 50, 100)');
    expect(page).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(page).toContain('app_private.can_access_lead(lead_row.id)');
    expect(page).toContain("'conversion'");
    expect(page).not.toMatch(/cost\s*\/\s*lead|cpl/i);
  });

  it('does not expose direct campaign/social writes or provider credentials', () => {
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.marketing_campaigns from anon, authenticated',
    );
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.social_posts from anon, authenticated',
    );
    expect(migration).not.toMatch(/encrypted_payload|access_token|refresh_token|client_secret/i);
    expect(migration).toContain(
      "status in ('DRAFT', 'SCHEDULED', 'PUBLISH_REQUESTED', 'PUBLISHED', 'FAILED', 'CANCELLED')",
    );
  });
});
