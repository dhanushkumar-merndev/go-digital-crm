import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609060002_template_approval_lifecycle.sql');
const sendEmail = source('supabase/functions/send-email/index.ts');
const sendMessage = source('supabase/functions/send-message/index.ts');
const api = source('src/features/administration/template-workspace-api.ts');
const workspace = source('src/features/administration/template-workspace.tsx');

describe('template approval lifecycle contract', () => {
  it('closes the gap that made every approved-template send unreachable', () => {
    // send-email refuses anything that is not APPROVED, and before this migration
    // no code path could set that status. These two assertions are what tie the
    // fix to the failure it exists for.
    expect(sendEmail).toContain("eq('status', 'APPROVED')");
    expect(migration).toContain('approve_template');
    expect(migration).toContain("status = 'APPROVED'");
  });

  it('validates the provider identifier per channel rather than at send time', () => {
    // Brevo ids are cast through z.int().positive() at send time, so a non-numeric
    // id stored here would be a template that silently never matches.
    expect(sendEmail).toContain('template_id: z.int().positive()');
    expect(migration).toContain('INVALID_BREVO_TEMPLATE_ID');
    expect(migration).toContain("'^[0-9]{1,18}$'");
    expect(migration).toContain('INVALID_WHATSAPP_TEMPLATE_NAME');
    expect(migration).toContain("'^[a-z0-9_]+$'");
  });

  it('keeps provider ids unique so template resolution stays single-row', () => {
    // send-email resolves with maybeSingle(); a duplicate approved provider id
    // would turn each send into a runtime error rather than a wrong send.
    expect(sendEmail).toContain('maybeSingle()');
    expect(migration).toContain('templates_approved_provider_id_idx');
    expect(migration).toContain('create unique index');
    expect(migration).toContain('TEMPLATE_PROVIDER_ID_IN_USE');
  });

  it('requires management permission and records an audited, replayable decision', () => {
    expect(migration).toContain('TEMPLATE_MANAGE_PERMISSION_REQUIRED');
    expect(migration).toContain("'integration.manage'");
    expect(migration).toContain("'template.approved'");
    expect(migration).toContain("'template.rejected'");
    expect(migration).toContain('security definer');
    expect(migration).toContain("set search_path = ''");
    // Re-approving with the same provider id is the natural retry and must not fail.
    expect(migration).toContain("'replayed', true");
    expect(migration).toContain('TEMPLATE_ALREADY_APPROVED');
  });

  it('keeps direct table writes revoked so status only moves through the RPCs', () => {
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.templates from anon, authenticated',
    );
    expect(migration).toContain(
      'revoke all on function public.approve_template(uuid, text, uuid) from public, anon',
    );
    expect(migration).toContain(
      'grant execute on function public.approve_template(uuid, text, uuid) to authenticated',
    );
  });

  it('releases the provider id on rejection so a replacement can reuse it', () => {
    expect(migration).toContain('reject_template');
    expect(migration).toContain('provider_template_id = null');
  });

  it('exposes typed RPC access and a channel-aware approval surface', () => {
    expect(api).toContain("rpc('approve_template'");
    expect(api).toContain("rpc('reject_template'");
    expect(workspace).toContain('ApproveTemplateDialog');
    expect(workspace).toContain('RejectTemplateDialog');
    expect(workspace).toContain('providerIdRules');
    // The admin is told this records an approval rather than requesting one.
    expect(workspace).toContain('Record provider approval');
    expect(workspace).toContain('This does not request approval');
  });

  it('states the WhatsApp template rule the drip and bulk work will depend on', () => {
    // Free-form WhatsApp text is only permitted inside the 24h service window,
    // which is why later drip steps must carry an approved template.
    expect(sendMessage).toContain('WHATSAPP_TEMPLATE_REQUIRED');
    expect(sendMessage).toContain('service_window_expires_at');
  });
});
