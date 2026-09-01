import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const navigation = read('src/config/navigation/index.ts');
const route = read('src/app/[role]/[[...slug]]/page.tsx');
const query = read('src/features/inventory/inventory-query.ts');
const demoLogin = read('src/lib/auth/development-demo-role-login.ts');
const demoSeed = read('scripts/seed-demo-tenant.mjs');
const migration = read('supabase/migrations/202609010003_inventory_executive_role.sql');

describe('Inventory Executive role', () => {
  it('has a dedicated branch-scoped inventory workspace preset', () => {
    expect(navigation).toContain("'inventory-executive': {");
    expect(navigation).toContain("label: 'Inventory Executive'");
    expect(route).toContain("role === 'inventory-executive'");
    expect(query).toContain("role === 'inventory-executive'");
  });

  it('can intake and update stock without manager allocation or transfer authority', () => {
    for (const permission of [
      'inventory.stock_check',
      'inventory.view',
      'inventory.create',
      'inventory.update',
    ]) {
      expect(migration).toContain(`'${permission}'`);
    }
    const executivePreset = migration.slice(
      migration.indexOf('-- Exact employee-level preset'),
      migration.indexOf('-- New or repaired system roles'),
    );
    expect(executivePreset).not.toContain("'inventory.move'");
    expect(executivePreset).not.toContain("'inventory.allocate'");
  });

  it('is available as a real seeded development login', () => {
    expect(demoLogin).toContain(
      "'inventory-executive': 'inventory-executive@demo.go-digital.invalid'",
    );
    expect(demoSeed).toContain("['inventory_executive', 'Inventory Executive', 'ONE_BRANCH']");
  });
});
