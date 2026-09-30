import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationName = '20260929120000_stock_unit_page_branch_scope_once.sql';
const migration = readFileSync(join(migrationsDirectory, migrationName), 'utf8');

describe('inventory vehicle list resolves branch scope once per call', () => {
  it('patches the deployed definition in place and refuses an unverified result', () => {
    expect(migration).toContain(
      "'public.get_stock_unit_page(text,integer,integer,text,uuid,text,text)'::regprocedure",
    );
    expect(migration).toContain('STOCK_UNIT_PAGE_PATCH_TARGET_NOT_FOUND');
    expect(migration).toContain("message = 'STOCK_UNIT_PAGE_PATCH_UNVERIFIED: '");
  });

  it('checks each branch once and filters units by the resolved list', () => {
    expect(migration).toContain(
      'app_private.can_access_branch(current_organization_id, branch_row.id)',
    );
    expect(migration).toContain('stock_row.branch_id = any(accessible_branch_ids)');
  });

  it('is not undone by a later migration re-creating the per-unit check', () => {
    for (const name of readdirSync(migrationsDirectory).filter((file) => file > migrationName)) {
      const text = readFileSync(join(migrationsDirectory, name), 'utf8');
      expect(text, `${name} re-creates get_stock_unit_page`).not.toMatch(
        /create or replace function public\.get_stock_unit_page/i,
      );
    }
  });
});
