import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationName = '20260929110000_operational_case_detail_single_case.sql';
const migration = readFileSync(join(migrationsDirectory, migrationName), 'utf8');

describe('opening an operational case reads that case only', () => {
  it('patches both deployed definitions in place and refuses an unverified result', () => {
    expect(migration).toContain("'app_private.operational_case_rows(uuid,text)'::regprocedure");
    expect(migration).toContain("'public.get_operational_case_detail(text,uuid)'::regprocedure");
    expect(migration).toContain("message = 'OPERATIONAL_CASE_DETAIL_PATCH_UNVERIFIED'");
    expect(migration).toContain(
      "message = 'OPERATIONAL_CASE_DETAIL_PATCH_TARGET_NOT_FOUND: rows branches'",
    );
  });

  it('filters every department branch by the case id before the access checks', () => {
    expect(migration).toContain('target_department text, target_case_id uuid)');
    expect(migration).toContain('    and case_row.id = target_case_id\n');
    expect(migration).toContain(') <> 5 then');
    expect(migration).toContain('current_organization_id, normalized_department, target_case_id');
  });

  it('keeps one owner-only version of the rows function', () => {
    expect(migration).toContain(
      'revoke all on function app_private.operational_case_rows(uuid, text, uuid)\n  from public, anon, authenticated;',
    );
    expect(migration).toContain('drop function app_private.operational_case_rows(uuid, text);');
  });

  it('is not undone by a later migration calling the two-argument form', () => {
    for (const name of readdirSync(migrationsDirectory).filter((file) => file > migrationName)) {
      const text = readFileSync(join(migrationsDirectory, name), 'utf8');
      expect(text, `${name} calls operational_case_rows without a case id`).not.toMatch(
        /operational_case_rows\(\s*current_organization_id,\s*normalized_department\s*\)/,
      );
    }
  });
});
