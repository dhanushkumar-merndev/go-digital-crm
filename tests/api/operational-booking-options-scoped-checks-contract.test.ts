import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationName = '20260929100000_operational_booking_options_scoped_checks.sql';
const migration = readFileSync(join(migrationsDirectory, migrationName), 'utf8');

describe('operational case booking picker checks access per scope, not per booking', () => {
  it('patches the deployed definition in place and refuses an unverified result', () => {
    expect(migration).toContain('pg_catalog.pg_get_functiondef(target)');
    expect(migration).toContain('OPERATIONAL_BOOKING_OPTIONS_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain("message = 'OPERATIONAL_BOOKING_OPTIONS_PATCH_UNVERIFIED: '");
    expect(migration).not.toMatch(
      /create or replace function public\.get_operational_case_booking_options/i,
    );
  });

  it('checks each distinct (branch, team, owner) once', () => {
    expect(migration).toContain('with booking_scopes as materialized (');
    expect(migration).toContain('visible_booking_scopes as materialized (');
    expect(migration).toContain('select 1 from visible_booking_scopes visible_row');
  });

  it('runs the customer check lazily, in display order, with a CASE', () => {
    expect(migration).toContain('offset 0');
    expect(migration).toContain('when broad_scope then true');
    expect(migration).toContain(
      'else app_private.can_access_customer(current_organization_id, sorted_row.customer_id)',
    );
    expect(migration).toContain("assignment_row.data_scope in ('ORGANIZATION', 'ALL_BRANCHES')");
  });

  it('is not undone by a later migration re-emitting the old per-booking checks', () => {
    for (const name of readdirSync(migrationsDirectory).filter((file) => file > migrationName)) {
      const text = readFileSync(join(migrationsDirectory, name), 'utf8');
      expect(text, `${name} re-creates get_operational_case_booking_options`).not.toMatch(
        /create or replace function public\.get_operational_case_booking_options/i,
      );
    }
  });
});
