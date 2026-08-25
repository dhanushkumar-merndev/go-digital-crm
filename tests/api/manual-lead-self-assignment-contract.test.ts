import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608250010_fix_self_assign_scope_column.sql',
  'utf8',
);
// The header comment names the broken column on purpose, so assertions about
// what the function *reads* have to look at executable SQL only.
const executable = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('manual lead self-assignment', () => {
  it('gives a hand-entered lead to the consultant who entered it', () => {
    expect(migration).toContain('selected_user_id := auth.uid();');
    expect(migration).toContain('self_assigned := true;');
    // Only when round robin has not already chosen an owner.
    expect(migration).toContain('if selected_user_id is null and exists (');
  });

  it('reads data_scope from the assignment, not the role', () => {
    // public.roles has no data_scope column; reading it there made every
    // create_lead call raise 42703.
    expect(migration).toContain("assignment_row.data_scope = 'OWN_RECORDS'");
    expect(executable).not.toContain('role_row.data_scope');
  });

  it('leaves a wider-scoped creator on the existing queue behaviour', () => {
    // A manager assigns deliberately; authoring a record is not a claim on it.
    expect(migration).toContain("and assignment_row.data_scope <> 'OWN_RECORDS'");
    expect(migration).toContain(') and not exists (');
  });

  it('records how ownership was decided, with a valid assignment_mode', () => {
    // method is public.assignment_mode: ROUND_ROBIN or MANUAL_ASSIGNMENT only.
    expect(migration).toContain(
      "then 'MANUAL_ASSIGNMENT' else 'ROUND_ROBIN' end::public.assignment_mode",
    );
    expect(migration).not.toContain("then 'MANUAL' else");
    expect(migration).toContain("'Manually created by the owning consultant'");
    expect(migration).toContain("'assignment_mode', case");
    expect(migration).toContain("then 'SELF_ON_CREATE'");
  });
});
