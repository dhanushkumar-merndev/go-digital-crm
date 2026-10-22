import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('reuses migration patch helpers in one database session without losing their edits', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create function public.migration_patch_probe() returns text language sql
      as $$ select 'before'::text $$;
    `);
    let previous = 'before';
    for (const file of readdirSync('supabase/migrations').sort()) {
      const migration = readFileSync(`supabase/migrations/${file}`, 'utf8');
      const helper = migration.match(
        /create(?: or replace)? function pg_temp\.patch_function\(target regprocedure, old_text text, new_text text\)[\s\S]*?\$\$;/,
      );
      if (!helper) continue;
      await db.exec(helper[0]);
      await db.query('select pg_temp.patch_function($1::regprocedure, $2::text, $3::text)', [
        'public.migration_patch_probe()',
        previous,
        file,
      ]);
      const result = await db.query<{ value: string }>(
        'select public.migration_patch_probe() as value',
      );
      expect(result.rows[0].value).toBe(file);
      previous = file;
    }
    expect(previous).not.toBe('before');
  } finally {
    await db.close();
  }
}, 30_000);
