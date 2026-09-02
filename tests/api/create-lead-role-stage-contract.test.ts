import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const restore = read(
  'supabase/migrations/202609020018_restore_telecaller_intake_on_create_lead.sql',
);

describe('create_lead opening stage by role', () => {
  it('only a Sales Consultant self-created lead becomes a sales handoff', () => {
    // Telecaller holds OWN_RECORDS too, so gating on scope alone sent a
    // hand-typed Telecaller lead straight to Transferred to Sales.
    expect(restore).toContain(
      "case when self_assigned and actor_is_sales_consultant then ''Transferred to Sales'' else ''New'' end",
    );
    // The fabricated handoff history and the contacted stamp are gated too; a
    // lead can otherwise read as handed-off to everything downstream while its
    // lifecycle still says New.
    expect(restore).toContain('if self_assigned and actor_is_sales_consultant then');
    expect(restore).toContain(
      "''contacted_on_create'', self_assigned and actor_is_sales_consultant",
    );
  });

  it('keeps self-assignment for both roles', () => {
    // An OWN_RECORDS user only sees leads assigned to themselves, so dropping
    // self-assignment would hide the lead the user just typed in.
    expect(restore).toContain("position('self_assigned := true;' in updated_definition) = 0");
  });

  it('refuses to apply unless every unguarded branch is gone', () => {
    expect(restore).toContain('TELECALLER_CREATE_LEAD_INTAKE_PATCH_TARGET_NOT_FOUND');
    expect(restore).toContain(
      "position(E'case when self_assigned then ''Transferred to Sales''' in updated_definition) > 0",
    );
  });

  it('no migration recreates create_lead wholesale after the intake rule landed', () => {
    // 202609020006 did exactly that and silently reverted 202608310003. A text
    // patch against the deployed definition fails loudly; a CREATE OR REPLACE
    // carrying an older copy of the body does not.
    const intakeVersion = '202608310003';
    // The two that caused the regression, kept as history. 202609020018 repairs
    // them; nothing new may join this list.
    const known = [
      '202609020006_link_created_leads_to_customers.sql',
      '202609020007_fix_create_lead_ambiguous_phone.sql',
    ];
    const offenders = readdirSync('supabase/migrations')
      .filter((file) => file.endsWith('.sql') && file.slice(0, 12) > intakeVersion)
      .filter((file) => !known.includes(file))
      .filter((file) => {
        const sql = read(`supabase/migrations/${file}`);
        return (
          sql.includes('create or replace function public.create_lead(') &&
          // Patching the live definition is the supported way to edit it.
          !sql.includes('pg_get_functiondef')
        );
      });
    expect(offenders).toEqual([]);
  });
});
