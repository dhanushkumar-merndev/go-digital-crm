import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PORTAL_WEBHOOK_CONNECT_ENABLED } from '../../src/config/feature-flags/portal-integrations';

const read = (path: string) => readFileSync(path, 'utf8');
const portals = ['justdial', 'cardekho', 'carwale', 'indiamart'] as const;

describe('portal email inbox connection', () => {
  const migration = read('supabase/migrations/202610100971_portal_email_inbox.sql');
  const connect = read('supabase/functions/integration-connect-portal-inbox/index.ts');
  const worker = read('trigger/portal-inbox-sync.ts');

  it('saves the connection only after the caller passes the integration scope check', () => {
    const scope = connect.indexOf("client.rpc('authorize_integration_scope'");
    const source = connect.indexOf("client.rpc('authorize_integration_connection_action'");
    const save = connect.indexOf("admin.rpc('save_portal_inbox_connection'");
    expect(scope).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(scope);
    expect(save).toBeGreaterThan(source);
    // A shared inbox is authorised against its source connection too.
    expect(connect).toMatch(
      /input\.mailbox\.mode === 'SHARED' \? input\.mailbox\.source_connection_id/,
    );
  });

  it('never returns or audits the mailbox password', () => {
    const start = connect.lastIndexOf('return success(');
    const response = connect.slice(start, connect.indexOf(');', start));
    expect(response).not.toMatch(/password/i);
    const audit = migration.slice(migration.indexOf('insert into public.audit_logs'));
    const auditRow = audit.slice(0, audit.indexOf(';'));
    expect(auditRow).not.toMatch(/password/i);
    // Only whether a credential was replaced is recorded, never the payload.
    expect(auditRow).not.toMatch(/target_encrypted_payload(?!\s+is not null)/);
    expect(connect).toContain('encryptJson(credential)');
  });

  it('keeps a stored password only for the same mailbox address', () => {
    expect(connect).toContain('credential.imap_username === mailboxAddress');
    expect(migration).toContain("message = 'PORTAL_INBOX_PASSWORD_REQUIRED'");
  });

  it('restricts the worker RPCs to the service role and claims with skip locked', () => {
    for (const fn of ['save_portal_inbox_connection', 'claim_due_portal_inboxes']) {
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`),
      );
    }
    expect(migration).toContain('for update of state skip locked');
    expect(migration).toContain('make_interval(mins => state.poll_interval_minutes)');
    expect(migration).toContain('poll_interval_minutes in (10, 20, 30)');
    expect(migration).not.toContain("'40001'");
  });

  it('lets authenticated users only read inbox state through the connection scope helper', () => {
    expect(migration).toContain('grant select on public.portal_inbox_sync_state to authenticated');
    expect(migration).toContain('grant select on public.portal_inbox_messages to authenticated');
    expect(
      migration.match(
        /using \(app_private\.can_access_connection\(organization_id, connection_id\)\)/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain(
      "public.authorize_integration_connection_action(\n    target_organization_id, target_connection_id, 'integration.manage'",
    );
  });

  it('opens the mailbox read-only and runs each claimed poll once', () => {
    expect(worker).toContain("getMailboxLock('INBOX', { readOnly: true })");
    expect(worker).toContain('`portal-inbox:${row.connection_id}:${row.claimed_at}`');
    expect(worker).toContain('senderMatches(candidate.from, domains)');
    expect(worker).toContain('`email:${candidate.messageId}`');
    expect(read('trigger/minute-dispatch.ts')).toContain('portal_inbox: runPortalInboxDue');
  });

  it('keeps the legacy webhook connect hidden but deployed', () => {
    expect(PORTAL_WEBHOOK_CONNECT_ENABLED).toBe(false);
    for (const portal of portals) {
      expect(existsSync(`supabase/functions/provider-webhook-${portal}/index.ts`)).toBe(true);
      expect(existsSync(`supabase/functions/integration-connect-${portal}/index.ts`)).toBe(true);
    }
  });
});
