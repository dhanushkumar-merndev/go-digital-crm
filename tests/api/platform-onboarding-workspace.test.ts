import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseDealershipQuery,
  toDealershipQueryString,
  toOrganizationSlug,
} from '../../src/features/platform/dealership-query';
import {
  parseOnboardingReviewQuery,
  toOnboardingReviewQueryString,
  toOnboardingSearchTerm,
} from '../../src/features/platform/onboarding-review-query';

const migration = readFileSync(
  'supabase/migrations/202608150012_platform_onboarding_workspace.sql',
  'utf8',
);
const reviewMigration = readFileSync(
  'supabase/migrations/202608150008_tenant_onboarding_review.sql',
  'utf8',
);
const downloadHandler = readFileSync('supabase/functions/presign-download/index.ts', 'utf8');
const tenantProvisionHandler = readFileSync('supabase/functions/tenant-provision/index.ts', 'utf8');
const rolePage = readFileSync('src/app/[role]/[[...slug]]/page.tsx', 'utf8');

describe('platform onboarding workspace contracts', () => {
  it('normalizes server-side page, status and sort inputs', () => {
    expect(
      parseOnboardingReviewQuery(
        new URLSearchParams(
          'page=3&pageSize=50&status=approved&sort=dealership%3Aasc&q=Acme%20Motors',
        ),
      ),
    ).toEqual({
      page: 3,
      pageSize: 50,
      status: 'approved',
      sort: 'dealership:asc',
      search: 'Acme Motors',
    });
    expect(parseOnboardingReviewQuery(new URLSearchParams('page=-1&pageSize=500'))).toMatchObject({
      page: 1,
      pageSize: 25,
      status: 'submitted',
    });
  });

  it('round-trips supported URL state and strips PostgREST grammar', () => {
    const encoded = toOnboardingReviewQueryString({
      page: 2,
      pageSize: 100,
      search: 'KA01 Acme',
      status: 'changes-required',
      sort: 'submitted:asc',
    });
    expect(parseOnboardingReviewQuery(new URLSearchParams(encoded))).toMatchObject({
      page: 2,
      pageSize: 100,
      search: 'KA01 Acme',
      status: 'changes-required',
      sort: 'submitted:asc',
    });
    expect(toOnboardingSearchTerm('Acme),status.eq.APPROVED')).toBe('AcmestatuseqAPPROVED');
  });

  it('indexes the platform queue and aggregates KPIs through RLS', () => {
    expect(migration).toContain('organization_onboarding_review_queue_idx');
    expect(migration).toContain('organization_onboarding_name_trgm_idx');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('get_platform_onboarding_kpis');
    expect(reviewMigration).toContain(
      "target_decision not in ('APPROVE', 'REQUEST_CHANGES', 'REJECT')",
    );
    expect(reviewMigration).toContain('app_private.mfa_policy_satisfied(null)');
  });

  it('permits platform document review only after CRM/MFA context checks', () => {
    expect(downloadHandler).toContain("context?.role_key === 'super-admin'");
    expect(downloadHandler).toContain('context?.mfa_satisfied === true');
    expect(downloadHandler).toContain("'authorize_object_action'");
  });

  it('keeps dealership list state server-pageable and creates safe tenant slugs', () => {
    const query = parseDealershipQuery(
      new URLSearchParams('page=2&pageSize=100&status=active&sort=name%3Aasc&q=North'),
    );
    expect(query).toMatchObject({
      page: 2,
      pageSize: 100,
      status: 'active',
      sort: 'name:asc',
      search: 'North',
    });
    expect(parseDealershipQuery(new URLSearchParams(toDealershipQueryString(query)))).toEqual(
      query,
    );
    expect(toOrganizationSlug('  MG Road Motors & Sons  ')).toBe('mg-road-motors-sons');
  });

  it('wires only completed platform routes and retains the secure tenant invite boundary', () => {
    expect(rolePage).toContain("slug[0] === 'dealerships'");
    expect(rolePage).toContain("slug[0] === 'onboarding-reviews'");
    expect(tenantProvisionHandler).toContain('admin.auth.admin.inviteUserByEmail');
    expect(tenantProvisionHandler).toContain('context.mfa_satisfied !== true');
    expect(migration).toContain('get_platform_dealership_kpis');
    expect(migration).toContain('platform_profiles_read');
  });
});
