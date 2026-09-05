import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const completionMigration = source(
  'supabase/migrations/202609040002_telecmi_ai_voice_completion.sql',
);
const lintFixMigration = source(
  'supabase/migrations/202609040006_post_push_function_lint_fixes.sql',
);
const api = source('src/features/calls/ai-call-field-review-api.ts');
const workspace = source('src/features/calls/ai-call-field-review-workspace.tsx');
const calls = source('src/features/calls/call-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('AI call field review contract', () => {
  it('keeps extraction review behind call, lead, and exact linked-customer authorization', () => {
    expect(completionMigration).toContain('get_ai_call_field_review');
    expect(completionMigration).toContain('review_ai_call_fields');
    expect(completionMigration).toContain("'call.view'");
    expect(completionMigration).toContain('app_private.can_access_record');
    expect(completionMigration).toContain("'lead.update'");
    expect(completionMigration).toContain('app_private.can_access_lead');
    expect(completionMigration).toContain("'customer.update'");
    expect(completionMigration).toContain('app_private.can_access_customer');
    expect(completionMigration).toContain('id = lead_record.customer_id');
    expect(completionMigration).not.toMatch(/where\s+normalized_phone\s*=/i);
  });

  it('applies only bounded, allowlisted decisions through the canonical lead mutation', () => {
    expect(completionMigration).toContain(
      'jsonb_array_length(target_decisions) not between 1 and 8',
    );
    expect(completionMigration).toContain("not in ('APPLIED', 'REJECTED', 'EDITED')");
    expect(completionMigration).toContain("'temperature', 'next_followup_at', 'lost_reason'");
    expect(completionMigration).toContain("message = 'LOST_REASON_REQUIRES_LOST_STATUS'");
    expect(completionMigration).toContain('from public.update_lead(');
    expect(completionMigration).toContain("'Approved AI call extraction'");
    expect(completionMigration).toContain("'customer.ai_fields_approved'");
    expect(completionMigration).toContain("'ai_call_fields.reviewed'");
    expect(completionMigration).not.toContain('update public.leads set');
  });

  it('uses Customer 360 identity as the displayed source of truth and never silently merges', () => {
    expect(completionMigration).toContain(
      "coalesce(customer_row.full_name, lead_row.customer_name, 'Customer')",
    );
    expect(completionMigration).toContain(
      "coalesce(customer_row.primary_phone, lead_row.phone, '')",
    );
    expect(completionMigration).toContain(
      "when 'email' then to_jsonb(coalesce(customer_row.primary_email, lead_row.email))",
    );
    expect(completionMigration).toContain('update public.customer_contacts set');
    expect(completionMigration).not.toMatch(/merge\s+into\s+public\.customers/i);
  });

  it('is idempotent per reviewer request and returns a safe replay result', () => {
    expect(completionMigration).toContain('ai_field_review_request_unique_idx');
    expect(completionMigration).toContain('audit_row.request_id = target_request_id');
    expect(completionMigration).toContain("message = 'IDEMPOTENCY_KEY_REUSED'");
    expect(completionMigration).toContain("jsonb_build_object('replayed', true)");
  });

  it('uses a typed RPC client and a reviewer screen instead of browser-side updates', () => {
    expect(api).toContain("rpc('get_ai_call_field_review'");
    expect(api).toContain("rpc('review_ai_call_fields'");
    expect(workspace).toContain('AI Auto Field Fill Review');
    expect(workspace).toContain('AI suggestions never update CRM until an authorized user accepts');
    expect(api).toContain('speaker_turns');
    expect(api).toContain('speaker_separation_method');
    expect(workspace).toContain('SpeakerTranscript');
    expect(workspace).toContain("type: 'success'");
  });

  it('returns the review through an unambiguous SELECT INTO statement', () => {
    expect(lintFixMigration).toContain(
      'create or replace function public.get_ai_call_field_review',
    );
    expect(lintFixMigration).toContain(') into result');
    expect(lintFixMigration).toContain('return result;');
  });

  it('makes the review available from a protected call detail and validates deep links', () => {
    expect(calls).toContain('Review AI fields');
    expect(calls).toContain('ai-review');
    expect(route).toContain("slug[2] === 'ai-review'");
    expect(route).toContain('AiCallFieldReviewWorkspace');
  });
});
