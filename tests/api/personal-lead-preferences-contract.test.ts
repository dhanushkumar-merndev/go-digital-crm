import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');
const api = readFileSync('src/features/leads/lead-workspace-api.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/202608250004_personal_lead_preferences.sql',
  'utf8',
);
const pinOrdering = readFileSync('supabase/migrations/202608250005_lead_pin_ordering.sql', 'utf8');

describe('personal lead pin and star contract', () => {
  it('syncs personal flags through a user-private, scope-checked API', () => {
    expect(migration).toContain('create table if not exists public.user_lead_preferences');
    expect(migration).toContain('primary key (organization_id, user_id, lead_id)');
    expect(migration).toContain(
      'alter table public.user_lead_preferences enable row level security',
    );
    expect(migration).toContain('create or replace function public.get_my_lead_preferences()');
    expect(migration).toContain('create or replace function public.set_my_lead_preference(');
    expect(migration).toContain('app_private.can_access_lead');
    expect(migration).toContain(
      'grant execute on function public.get_my_lead_preferences() to authenticated',
    );
    expect(api).toContain("rpc('get_my_lead_preferences')");
    expect(api).toContain("rpc('set_my_lead_preference'");
  });

  it('keeps pins at the top of every normal lead view and only exposes Starred as a tab', () => {
    expect(workspace).toContain("{ label: 'Starred', value: 'starred' as const");
    expect(workspace).not.toContain("{ label: 'Pinned', value: 'pinned' as const");
    // Number(undefined) is NaN and a NaN comparator result is read as 0, which
    // left every pinned row exactly where it started.
    expect(workspace).not.toContain('Number(personalFlags[right.id]?.pinned)');
    expect(workspace).toContain('const pinRank = (leadId: string)');
    expect(workspace).toContain('return rightPin.localeCompare(leftPin);');
  });

  it('ranks pins by recency so the newest pin sits above earlier pins', () => {
    expect(pinOrdering).toContain('add column if not exists pinned_at timestamptz');
    expect(pinOrdering).toContain('next_pinned_at := coalesce(existing_pinned_at, now());');
    expect(pinOrdering).toContain(
      'order by preference_row.pinned_at desc nulls last, preference_row.updated_at desc',
    );
    expect(api).toContain('pinnedAt: string | null');
  });

  it('orders pins ahead of the whole filtered set so they reach page one', () => {
    expect(pinOrdering).toContain(
      'left join pinned_leads pin_row on pin_row.lead_id = lead_row.id',
    );
    expect(pinOrdering).toContain('pin_row.pin_rank asc nulls last,');
    expect(pinOrdering).toContain(
      'create index if not exists user_lead_preferences_pinned_rank_idx',
    );
  });

  it('reorders optimistically and rolls back a rejected write', () => {
    expect(workspace).toContain('onMutate: async ({ leadId, flag, active }) => {');
    expect(workspace).toContain('queryClient.cancelQueries({ queryKey: personalPreferenceKey })');
    expect(workspace).toContain(
      'queryClient.setQueryData<PersonalLeadFlags>(personalPreferenceKey, context.snapshot)',
    );
    expect(workspace).toContain(
      "invalidateQueries({ queryKey: ['lead-workspace', ...queryScope] })",
    );
  });

  it('makes the row controls personal-only toggles, without mutating lead data', () => {
    expect(workspace).toContain("'pinned'");
    expect(workspace).toContain("'starred'");
    expect(workspace).toContain('onPersonalFlagChange');
    expect(workspace).toContain('setPersonalLeadPreference');
    expect(workspace).not.toContain('updateLead({ leadId: row.original.id, pinned');
  });
});
