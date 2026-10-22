import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202610221437_review_request_dispatch.sql');
const worker = source('trigger/review-request-dispatch.ts');
const marketingDispatch = source('trigger/marketing-dispatch.ts');
const api = source('src/features/marketing/marketing-automation-api.ts');

function fn(name: string) {
  const start = migration.indexOf(`create or replace function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$;', start));
}

describe('review request dispatch', () => {
  it('requires an approved template for every provider channel', () => {
    const create = fn('public.create_marketing_review_request');
    expect(create).toContain("message = 'REVIEW_TEMPLATE_REQUIRED'");
    expect(create).toContain("template_source.meta_status = 'APPROVED'");
    expect(create).toContain('template_source.removed_from_meta_at is null');
    expect(create).toContain("upper(template_source.status) = 'APPROVED'");
    // A field that renders empty (say, a branch without a review link) is refused
    // up front rather than sent to the provider and rejected there.
    expect(create).toContain("message = 'REVIEW_TEMPLATE_VARIABLE_REQUIRED'");
    expect(create).toContain("message = 'REVIEW_CUSTOMER_OPTED_OUT'");
    expect(create).toContain("message = 'REVIEW_RECIPIENT_MISSING'");
  });

  it('records MANUAL as sent by the employee, never as a provider send', () => {
    const create = fn('public.create_marketing_review_request');
    expect(create).toContain("initial_status := 'SENT'");
    expect(create).toContain("'mode', case when normalized_channel = 'MANUAL' then 'MANUAL'");
    expect(migration).toContain(
      "'sent_today', (select count(*) from reviews where channel <> 'MANUAL' and sent_at is not null",
    );
  });

  it('keeps the queue service-role only, leased, and retried with a cap', () => {
    for (const name of [
      'public.claim_due_review_requests',
      'public.complete_review_request',
      'public.fail_review_request',
    ]) {
      expect(fn(name)).toContain("if auth.role() <> 'service_role' then");
    }
    expect(migration).toMatch(
      /revoke all on function public\.claim_due_review_requests\(text, integer\),[\s\S]*?from public, anon, authenticated;/,
    );
    const claim = fn('public.claim_due_review_requests');
    expect(claim).toContain('for update of request_row skip locked');
    expect(claim).toContain('request_row.lease_until < now()');
    // Rows queued before templates existed can never send; they fail visibly.
    expect(claim).toContain("safe_error_code = 'REVIEW_TEMPLATE_REQUIRED'");
    // Normalized numbers carry the country code that Meta and MSG91 need.
    expect(claim).toContain('customer_row.normalized_whatsapp_phone');
    expect(fn('public.fail_review_request')).toContain('source_row.attempts >= 3');
    expect(fn('public.complete_review_request')).toContain(
      'and source_row.lease_token = target_lease_token',
    );
  });

  it('moves a sent request to delivered from the WhatsApp receipt, never backwards', () => {
    expect(migration).toContain("request_row.channel = 'WHATSAPP'");
    expect(migration).toContain(
      "where request_row.id = review_request_id and request_row.status = 'SENT'",
    );
  });

  it('runs in the marketing pass through the shared provider senders', () => {
    expect(marketingDispatch).toContain('runReviewRequestDispatch(supabase)');
    expect(worker).toContain("import { deliver, type DripMessage } from './drip-dispatch'");
    expect(worker).toContain("rpc<ReviewRequest[]>('claim_due_review_requests'");
    expect(worker).toContain("rpc('complete_review_request'");
    expect(worker).toContain("rpc('fail_review_request'");
    expect(worker).toContain("'REVIEW_WHATSAPP_REJECTED'");
    expect(worker).not.toContain("'REVIEW_WHATSAPP_RATE_LIMITED'");
  });

  it('sends the chosen template and its field values from the client', () => {
    expect(api).toContain("rpc('get_marketing_review_template_options'");
    expect(api).toContain('target_template_id: input.templateId ?? null');
    expect(api).toContain('target_template_variables: input.templateVariables ?? {}');
    expect(api).toContain('safe_error_code: nullableString.default(null)');
  });
});
