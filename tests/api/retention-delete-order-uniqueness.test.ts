import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `retention_table_allowlist.delete_order` is UNIQUE, and the value decides purge
 * sequence so a child table must come before the parent it references. A clash
 * only surfaces when the migration is applied to a database that already holds
 * the other row, which means a local run can pass and the push still fail.
 */
describe('retention allowlist delete_order', () => {
  const directory = join(process.cwd(), 'supabase/migrations');
  const entry = /'([a-z_]+)',\s*'(?:DELETE|ANONYMIZE|RETAIN)',\s*(\d+)/g;

  it('assigns each table one order and never reuses an order across tables', () => {
    const owners = new Map<number, string>();
    const collisions: string[] = [];
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(join(directory, file), 'utf8');
      for (const [, table, order] of sql.matchAll(entry)) {
        const value = Number(order);
        const existing = owners.get(value);
        // A migration may restate its own table's order via ON CONFLICT.
        if (existing && existing !== table)
          collisions.push(`${value}: ${existing} vs ${table} (${file})`);
        else owners.set(value, table);
      }
    }
    expect(collisions).toEqual([]);
  });
});
