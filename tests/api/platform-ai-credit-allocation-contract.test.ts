import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPlatformAiCreditAllocationFailure,
  platformAiCreditAllocationFailureDescription,
} from '../../src/features/platform/platform-ai-usage-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220033_platform_ai_credit_allocations.sql');
const api = source('src/features/platform/platform-ai-usage-workspace-api.ts');
const workspace = source('src/features/platform/platform-ai-usage-workspace.tsx');
const query = source('src/features/platform/platform-ai-usage-query.ts');

describe('platform AI-credit allocation contract', () => {
  it('allows allocations only to a Super Admin with MFA and records immutable audit data', () => {
    expect(migration).toContain('create or replace function public.grant_platform_ai_credits(');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain("'ALLOCATION'");
    expect(migration).toContain("'PLATFORM_SUPER_ADMIN'");
    expect(migration).toContain("'platform.ai_credits.allocated'");
    expect(migration).toContain('target_amount not between 1 and 1000000');
    expect(migration).toContain("'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT'");
    expect(migration).toContain("organization_row.status in ('ACTIVE', 'SUPPORT_MAINTENANCE')");
  });

  it('removes allocation rights from tenant roles while preserving read-only owner visibility', () => {
    expect(migration).toContain("'credit.view'");
    expect(migration).toContain("permission_row.permission_key = 'credit.allocate'");
    expect(migration).toContain("role_row.role_key <> 'super_admin'");
    expect(migration).toContain("permission_row.permission_key = 'credit.consume'");
    expect(migration).toContain("has_permission(current_organization_id, 'credit.view')");
    expect(migration).toContain('create policy credit_ledger_read');
    expect(migration).toContain('revoke all on function public.consume_credits(');
    expect(migration).toContain(') from public, anon, authenticated;');
  });

  it('exposes a bounded, Super-Admin-only ledger reader', () => {
    expect(migration).toContain('create or replace function public.get_platform_ai_credit_ledger(');
    expect(migration).toContain('target_page_size not in (25, 50, 100)');
    expect(migration).toContain('(target_before_at is null) <> (target_before_id is null)');
    expect(migration).toContain('(ledger_row.created_at, ledger_row.id) <');
    expect(migration).toContain('limit target_page_size + 1');
    expect(migration).toContain(
      'revoke all on function public.grant_platform_ai_credits(uuid, bigint, text, uuid)',
    );
    expect(migration).toContain('grant execute on function public.get_platform_ai_credit_ledger');
  });
});

describe('platform AI-credit allocation workspace contract', () => {
  it('validates allocation and ledger RPC responses', () => {
    expect(api).toContain("rpc('grant_platform_ai_credits'");
    expect(api).toContain("rpc('get_platform_ai_credit_ledger'");
    expect(api).toContain('creditAllocationResultSchema');
    expect(api).toContain('creditLedgerSchema');
  });

  it('keeps credit allocation and audit history in the Super Admin workspace', () => {
    expect(workspace).toContain('Add AI credits');
    expect(workspace).toContain('AI credit ledger');
    expect(workspace).toContain('grantPlatformAiCredits');
    expect(workspace).toContain('fetchPlatformAiCreditLedger');
    expect(workspace).toContain("['platform-ai-credit-ledger', organization.id, cursor]");
    expect(workspace).toContain('setAllocationRequestId(requestId())');
  });

  it('does not mislabel every allocation failure as an MFA problem', () => {
    expect(query).toContain("'ORGANIZATION_NOT_ACTIVE'");
    expect(query).toContain('AI_CREDIT_ORGANIZATION_NOT_ACTIVE');
    expect(query).toContain('Approve its onboarding before adding AI credits.');
    expect(workspace).toContain("failure === 'MFA_REQUIRED'");
    expect(workspace).toContain("router.push('/access/mfa')");
    expect(workspace).not.toContain('Confirm your Super Admin MFA session and retry.');
  });

  it('classifies plain PostgREST errors and keeps unrelated permission errors generic', () => {
    const inactive = classifyPlatformAiCreditAllocationFailure({
      code: 'P0002',
      message: 'AI_CREDIT_ORGANIZATION_NOT_ACTIVE',
    });
    const mfa = classifyPlatformAiCreditAllocationFailure({
      code: '42501',
      message: 'SUPER_ADMIN_MFA_REQUIRED',
    });
    const unknown = classifyPlatformAiCreditAllocationFailure({
      code: '42501',
      message: 'OTHER_PERMISSION_REQUIRED',
    });
    const misleadingDetails = classifyPlatformAiCreditAllocationFailure({
      code: '42501',
      message: 'OTHER_PERMISSION_REQUIRED',
      details: 'SUPER_ADMIN_MFA_REQUIRED',
    });

    expect(inactive).toBe('ORGANIZATION_NOT_ACTIVE');
    expect(platformAiCreditAllocationFailureDescription(inactive)).toMatch(/not active/i);
    expect(mfa).toBe('MFA_REQUIRED');
    expect(platformAiCreditAllocationFailureDescription(mfa)).toMatch(/MFA/i);
    expect(unknown).toBe('UNKNOWN');
    expect(misleadingDetails).toBe('UNKNOWN');
    expect(platformAiCreditAllocationFailureDescription(unknown)).not.toMatch(/MFA/i);
    expect(platformAiCreditAllocationFailureDescription(unknown)).toMatch(/duplicate credits/i);
  });
});
