import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220026_ai_call_field_review_workspace.sql');
const api = source('src/features/calls/ai-call-field-review-api.ts');
const workspace = source('src/features/calls/ai-call-field-review-workspace.tsx');
const calls = source('src/features/calls/call-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('AI call field review contract', () => {
  it('keeps extraction review behind call scope and lead-update authorization', () => {
    expect(migration).toContain('get_ai_call_field_review');
    expect(migration).toContain('review_ai_call_fields');
    expect(migration).toContain("'call.view'");
    expect(migration).toContain('app_private.can_access_record');
    expect(migration).toContain("'lead.update'");
    expect(migration).toContain('app_private.can_access_lead');
  });

  it('only permits a narrowly allowlisted set of lead fields to be applied', () => {
    expect(migration).toContain(
      "('customer_name', 'phone', 'email', 'interested_model', 'lifecycle_status', 'temperature', 'next_followup_at')",
    );
    expect(migration).toContain("decision_row.decision not in ('APPLIED', 'REJECTED', 'EDITED')");
    expect(migration).toContain("resolved_value #>> '{}'");
    expect(migration).not.toContain("resolved_value #>> ''");
    expect(migration).toContain("'ai_call_fields.reviewed'");
  });

  it('uses a typed RPC client and a reviewer screen instead of browser-side updates', () => {
    expect(api).toContain("rpc('get_ai_call_field_review'");
    expect(api).toContain("rpc('review_ai_call_fields'");
    expect(workspace).toContain('AI Auto Field Fill Review');
    expect(workspace).toContain('AI suggestions never update CRM until an authorized user accepts');
    expect(workspace).toContain("type: 'success'");
  });

  it('makes the review available from a protected call detail and validates deep links', () => {
    expect(calls).toContain('Review AI fields');
    expect(calls).toContain('ai-review');
    expect(route).toContain("slug[2] === 'ai-review'");
    expect(route).toContain('AiCallFieldReviewWorkspace');
  });
});
