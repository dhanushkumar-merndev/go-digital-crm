import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609060003_customer_drip_dispatch.sql');
const worker = source('trigger/drip-dispatch.ts');
const enrollment = source('supabase/migrations/202608260005_customer_drip_messaging.sql');
const config = source('trigger.config.ts');

describe('customer drip dispatch contract', () => {
  it('supplies the dispatcher the enrollment schema was always indexed for', () => {
    // The due index and its comment predate any worker; nothing consumed it.
    expect(enrollment).toContain("The dispatcher's only query");
    expect(migration).toContain('claim_due_drip_messages');
    expect(worker).toContain("id: 'drip-dispatch'");
    // Tasks are auto-discovered from ./trigger, so no registration is needed.
    expect(config).toContain("dirs: ['./trigger']");
  });

  it('claims a bounded batch so cost tracks the batch, never the queue depth', () => {
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain('limit target_batch_size');
    expect(migration).toContain('target_batch_size not between 1 and 100');
    expect(migration).toContain('customer_drip_messages_due_idx');
    expect(migration).toContain("where status = 'QUEUED'");
  });

  it('holds a claim in its own state so a second pass cannot double-send', () => {
    expect(migration).toContain("'SENDING'");
    expect(migration).toContain(
      "check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'))",
    );
    expect(migration).toContain('lease_token');
    expect(migration).toContain('release_stalled_drip_messages');
    expect(worker).toContain("rpc('release_stalled_drip_messages'");
  });

  it('sends every channel as an approved template, which is why drip could not deliver', () => {
    // Outside the 24h window Meta accepts only templates, and email_messages has
    // no body column at all, so free prose was undeliverable on both channels.
    expect(migration).toContain('template_id uuid references public.templates(id)');
    expect(migration).toContain("upper(template_row.status) = 'APPROVED'");
    expect(worker).toContain('DRIP_TEMPLATE_NOT_APPROVED');
    expect(worker).toContain("type: 'template'");
    expect(worker).toContain('templateId: Number(message.template_provider_id)');
  });

  it('reuses the message id as the provider idempotency key across retries', () => {
    expect(worker).toContain("'idempotency-key': message.application_message_id");
    expect(worker).toContain('biz_opaque_callback_data: message.application_message_id');
    expect(migration).toContain('claimed.id,\n    claimed.lease_token');
  });

  it('names the SMS gap instead of retrying a channel that cannot succeed', () => {
    expect(worker).toContain('DRIP_SMS_PROVIDER_NOT_CONFIGURED');
  });

  it('backs off, gives up at the attempt cap, and completes finished enrollments', () => {
    // attempts is capped at 10 by the table's own check constraint.
    expect(migration).toContain('message_row.attempts >= 10');
    expect(migration).toContain("interval '6 hours'");
    expect(migration).toContain("status = 'COMPLETED'");
    expect(migration).toContain('not exists (');
  });

  it('keeps the queue callable only by the worker role', () => {
    expect(migration).toContain('SERVICE_ROLE_REQUIRED');
    expect(migration).toContain(
      'revoke all on function public.claim_due_drip_messages(text, integer) from public, anon, authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.claim_due_drip_messages(text, integer) to service_role',
    );
    expect(migration).toContain('security definer');
    expect(migration).toContain("set search_path = ''");
  });

  it('preserves the reviewed copy and the reviewed schedule', () => {
    // message_body stays the rendered text the enroller approved, and retries use
    // their own clock so scheduled_for is never rewritten underneath them.
    expect(enrollment).toContain('Stored already personalised');
    expect(migration).toContain('next_attempt_at');
    expect(migration).toContain('would rewrite');
  });
});
