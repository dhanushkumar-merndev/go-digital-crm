import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220019_social_content_calendar.sql');
const api = source('src/features/marketing/social-content-calendar-api.ts');
const calendar = source('src/features/marketing/social-content-calendar.tsx');
const workspace = source('src/features/marketing/marketing-workspace.tsx');

describe('social content calendar backend contract', () => {
  it('uses a bounded date window and the existing marketing permission boundary', () => {
    expect(migration).toContain('create or replace function public.get_social_content_calendar(');
    expect(migration).toContain('target_days not in (7, 14, 31)');
    expect(migration).toContain("target_timezone not in ('Asia/Kolkata', 'UTC')");
    expect(migration).toContain("'marketing.view'");
    expect(migration).toContain("message = 'MARKETING_VIEW_PERMISSION_REQUIRED'");
  });

  it('returns only scoped scheduled posts and caps the calendar projection', () => {
    expect(migration).toContain('social_posts_calendar_idx');
    expect(migration).toContain('post_source.scheduled_for >= range_start');
    expect(migration).toContain('post_source.scheduled_for < range_end');
    expect(migration).toContain(
      'app_private.can_access_branch(current_organization_id, post_source.branch_id)',
    );
    expect(migration).toContain('limit 500');
    expect(migration).not.toContain('media_object_file_ids');
  });

  it('excludes anonymous execution', () => {
    expect(migration).toContain(
      'revoke all on function public.get_social_content_calendar(date, integer, text) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.get_social_content_calendar(date, integer, text) to authenticated',
    );
  });
});

describe('social content calendar web contract', () => {
  it('validates the RPC payload and scopes React Query to the requested calendar range', () => {
    expect(api).toContain('const calendarSchema = z.object({');
    expect(api).toContain("rpc('get_social_content_calendar'");
    expect(calendar).toContain("['social-content-calendar', startDate, days]");
    expect(calendar).toContain('No scheduled posts');
  });

  it('appears only in the existing real Social Posts marketing view', () => {
    expect(workspace).toContain("from './social-content-calendar'");
    expect(workspace).toContain("routeQuery.view === 'SOCIAL_POSTS'");
    expect(workspace).toContain('<SocialContentCalendar />');
  });
});
