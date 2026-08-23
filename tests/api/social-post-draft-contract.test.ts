import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220021_social_post_draft_workflow.sql');
const api = source('src/features/marketing/social-post-draft-api.ts');
const dialog = source('src/features/marketing/social-post-draft-dialog.tsx');
const workspace = source('src/features/marketing/marketing-workspace.tsx');

describe('social post draft workflow contract', () => {
  it('restricts draft options and creation to marketing social managers in their branch scope', () => {
    expect(migration).toContain(
      'create or replace function public.get_social_post_draft_options()',
    );
    expect(migration).toContain("'marketing.social.manage'");
    expect(migration).toContain(
      'app_private.can_access_branch(current_organization_id, branch_row.id)',
    );
    expect(migration).toContain('SOCIAL_POST_ORGANIZATION_SCOPE_DENIED');
    expect(migration).toContain('SOCIAL_POST_BRANCH_SCOPE_DENIED');
  });

  it('creates only provider-independent drafts and makes retry requests idempotent and auditable', () => {
    expect(migration).toContain('create or replace function public.create_social_post_draft(');
    expect(migration).toContain(
      "normalized_platform not in ('FACEBOOK', 'INSTAGRAM', 'GOOGLE_BUSINESS_PROFILE', 'OTHER')",
    );
    expect(migration).toContain("normalized_content, 'DRAFT', auth.uid()");
    expect(migration).toContain("audit_row.action = 'social_post.draft_created'");
    expect(migration).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');
    expect(migration).toContain("'social_post.draft_created', 'social_post'");
    expect(migration).not.toContain("'PUBLISH_REQUESTED'");
  });

  it('uses authenticated RPCs and refreshes only affected marketing views', () => {
    expect(api).toContain("rpc('get_social_post_draft_options')");
    expect(api).toContain("rpc('create_social_post_draft'");
    expect(dialog).toContain('globalThis.crypto.randomUUID()');
    expect(dialog).toContain("invalidateQueries({ queryKey: ['marketing-workspace'] })");
    expect(dialog).toContain("invalidateQueries({ queryKey: ['social-content-calendar'] })");
    expect(workspace).toContain('<SocialPostDraftAction />');
  });
});
