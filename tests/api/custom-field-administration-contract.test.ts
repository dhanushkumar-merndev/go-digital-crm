import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}
const migration = source('supabase/migrations/202608220023_custom_field_administration.sql');
const api = source('src/features/administration/custom-field-workspace-api.ts');
const workspace = source('src/features/administration/custom-field-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('custom field administration contract', () => {
  it('limits organization-wide configuration to role-management authority and validates typed field input', () => {
    expect(migration).toContain(
      "app_private.has_permission(current_organization_id, 'role.manage')",
    );
    expect(migration).toContain('app_private.has_organization_wide_scope(current_organization_id)');
    expect(migration).toContain(
      "normalized_type not in ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT')",
    );
    expect(migration).toContain("normalized_key !~ '^[a-z][a-z0-9_]{1,62}$'");
  });
  it('uses audited idempotent creation and optimistic active-state changes', () => {
    expect(migration).toContain('custom_field.created');
    expect(migration).toContain('custom_field.status_changed');
    expect(migration).toContain('REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');
    expect(migration).toContain('CUSTOM_FIELD_VERSION_CONFLICT');
    expect(migration).toContain('version = version + 1');
  });
  it('uses bounded server pagination and routes Client Admins to the real workspace', () => {
    expect(api).toContain("rpc('get_custom_field_administration_page'");
    expect(api).toContain("rpc('create_custom_field_definition'");
    expect(api).toContain("rpc('set_custom_field_active'");
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("['custom-field-administration', search, status, page, pageSize]");
    expect(route).toContain("role === 'client-admin' && slug[0] === 'custom-fields'");
  });
});
