import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202608240004_harden_legacy_customer_360_sections.sql',
  'utf8',
);
const seed = readFileSync('scripts/seed-demo-tenant.mjs', 'utf8');
const telecallerPreset = seed.slice(
  seed.indexOf('const telecallerPermissionKeys'),
  seed.indexOf('const rolePermissionPrefixes'),
);

describe('legacy Customer 360 permission hardening', () => {
  it('keeps the original scoped RPC private behind a dedicated permission wrapper', () => {
    expect(migration).toContain(
      'alter function public.get_customer_360(uuid) set schema app_private',
    );
    expect(migration).toContain('get_customer_360_legacy_20260824');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain("'followup.view'");
    expect(migration).toContain("'appointment.view'");
    expect(migration).toContain("jsonb_set(result, '{followups}', '[]'::jsonb, true)");
    expect(migration).toContain("jsonb_set(result, '{appointments}', '[]'::jsonb, true)");
  });

  it('binds customer and section permissions to the assignment that supplies record scope', () => {
    expect(migration).toContain(
      'create or replace function app_private.resolve_permission_record_scope(',
    );
    expect(migration).toContain('role_permission_row.role_id = assignment_row.role_id');
    expect(migration).toContain('permission_row.permission_key = any(');
    expect(migration).toContain("array['customer.view']::text[]");
    expect(migration).toContain("array['lead.view']::text[]");
    expect(migration).toContain("array['followup.view']::text[]");
    expect(migration).toContain("array['appointment.view']::text[]");
    expect(migration).toContain('followup_row.branch_id = any(followup_scope.branch_scope_ids)');
    expect(migration).toContain('appointment_row.team_id = any(appointment_scope.team_scope_ids)');
    expect(migration).toContain('lead_row.branch_id = any(lead_scope.branch_scope_ids)');
    expect(migration).toContain(
      'app_private.resolve_permission_record_scope(uuid, text[])\n  from public, anon, authenticated',
    );
  });

  it('reconciles demo Telecaller permissions to its frozen role preset', () => {
    for (const permission of [
      'followup.view',
      'appointment.view',
      'document.upload',
      'email.send',
    ]) {
      expect(telecallerPreset).toContain(`'${permission}'`);
    }
    for (const unsupported of ['test_drive.', 'quotation.', 'booking.', 'approval.']) {
      expect(telecallerPreset).not.toContain(unsupported);
    }
    expect(seed).toContain("role.role_key === 'telecaller_bdc'");
    expect(seed).toContain("permission_id: `not.in.(${allowedPermissionIds.join(',')})`");
  });
});
