import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/202608260004_customer_field_templates.sql');
const api = source('src/features/administration/custom-field-workspace-api.ts');
const workspace = source('src/features/administration/custom-field-workspace.tsx');
const seed = source('scripts/seed-demo-customer-personalisation.mjs');

describe('customer field templates', () => {
  it('fixes the key, label and type server-side rather than in the browser', () => {
    expect(migration).toContain('function app_private.customer_field_template');
    expect(migration).toContain('function public.apply_customer_field_template');
    for (const key of ['date_of_birth', 'wedding_anniversary', 'spouse_name', 'occupation']) {
      expect(migration).toContain(key);
    }
    // Applying a pack sends a template name and nothing else; the per-field
    // shape stays confined to the single-field create path beside it.
    expect(api).toContain('target_template_key');
    const applyBody = api.slice(api.indexOf('export async function applyCustomerFieldTemplate'));
    expect(applyBody).not.toContain('target_field_type');
    expect(applyBody).not.toContain('target_field_key');
  });

  it('carries the same administration ceiling as creating a field by hand', () => {
    expect(migration).toContain('has_organization_wide_scope');
    expect(migration).toContain("has_permission(current_organization_id, 'role.manage')");
    expect(migration).toContain('CUSTOM_FIELD_MANAGE_PERMISSION_REQUIRED');
  });

  it('is additive and safe to press twice', () => {
    // A key that already exists is reported, never overwritten or reactivated.
    expect(migration).toContain('skipped_keys := skipped_keys || template_row.field_key');
    expect(migration).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');
    expect(api).toContain('skipped');
    expect(workspace).toContain('Fields you');
  });

  it('offers the packs in the administration workspace only', () => {
    expect(workspace).toContain('customerFieldTemplates');
    expect(workspace).toContain('applyCustomerFieldTemplate');
    expect(workspace).toContain('Start from a field set');
  });

  it('seeds values as raw json so they render as entered', () => {
    expect(seed).toContain('CUSTOMER_PERSONAL');
    expect(seed).toContain("resource_type: 'CUSTOMER'");
    expect(seed).not.toContain('value: JSON.stringify(value)');
  });
});
