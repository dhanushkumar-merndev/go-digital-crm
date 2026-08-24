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
