import { createClient } from '@/lib/supabase/client';
import {
  onboardingReviewSortOptions,
  onboardingReviewStatusValues,
  toOnboardingSearchTerm,
  type OnboardingReviewQuery,
} from './onboarding-review-query';

export type OnboardingSubmission = {
  id: string;
  organization_id: string;
  version: number;
  organization_name: string;
  legal_name: string;
  gst_number: string;
  dealer_information: {
    registered_address?: string;
    dealership_license_number?: string;
    manufacturer_names?: string;
    contact_phone?: string;
    contact_email?: string;
  };
  status: 'SUBMITTED' | 'CHANGES_REQUIRED' | 'APPROVED' | 'REJECTED';
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};

export type OnboardingDocument = {
  id: string;
  document_type: 'OWNER_IDENTITY' | 'GST_CERTIFICATE' | 'DEALERSHIP_AUTHORIZATION';
  object_file_id: string;
  created_at: string;
};

export type OnboardingReviewKpis = {
  submitted: number;
  changes_required: number;
  approved: number;
  rejected: number;
};

export type OnboardingReviewResult = {
  records: OnboardingSubmission[];
  total: number;
  kpis: OnboardingReviewKpis;
};

const listColumns =
  'id,organization_id,version,organization_name,legal_name,gst_number,dealer_information,status,submitted_by,submitted_at,reviewed_by,reviewed_at,review_note';

const emptyKpis: OnboardingReviewKpis = {
  submitted: 0,
  changes_required: 0,
  approved: 0,
  rejected: 0,
};

export async function assertPlatformReviewAccess() {
  const { data, error } = await createClient().rpc('get_access_context');
  if (error) throw error;
  const context = data as {
    destination?: string;
    role_key?: string;
    mfa_satisfied?: boolean;
  } | null;
  if (
    context?.destination !== 'CRM' ||
    context.role_key !== 'super-admin' ||
    context.mfa_satisfied !== true
  )
    throw new Error('PLATFORM_REVIEW_ACCESS_REQUIRED');
  return true;
}

export async function fetchOnboardingReviews(
  query: OnboardingReviewQuery,
): Promise<OnboardingReviewResult> {
  await assertPlatformReviewAccess();
  const supabase = createClient();
  const sort = onboardingReviewSortOptions[query.sort];
  let listQuery = supabase
    .from('organization_onboarding_submissions')
    .select(listColumns, { count: 'exact' })
    .order(sort.column, { ascending: sort.ascending })
    .order('id', { ascending: sort.ascending })
    .range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1);

  if (query.status !== 'all')
    listQuery = listQuery.eq('status', onboardingReviewStatusValues[query.status]);
  if (query.search) {
    const term = toOnboardingSearchTerm(query.search);
    if (term)
      listQuery = listQuery.or(
        `organization_name.ilike.%${term}%,legal_name.ilike.%${term}%,gst_number.ilike.%${term}%`,
      );
  }

  const [listResponse, kpiResponse] = await Promise.all([
    listQuery,
    supabase.rpc('get_platform_onboarding_kpis'),
  ]);
  if (listResponse.error) throw listResponse.error;
  if (kpiResponse.error) throw kpiResponse.error;
  const rawKpis = (kpiResponse.data?.[0] ?? null) as Partial<
    Record<keyof OnboardingReviewKpis, string | number | null>
  > | null;
  const kpis = Object.fromEntries(
    Object.keys(emptyKpis).map((key) => [
      key,
      Number(rawKpis?.[key as keyof OnboardingReviewKpis] ?? 0),
    ]),
  ) as OnboardingReviewKpis;
  return {
    records: (listResponse.data ?? []) as OnboardingSubmission[],
    total: listResponse.count ?? 0,
    kpis,
  };
}

export async function fetchOnboardingDocuments(submissionId: string) {
  const { data, error } = await createClient()
    .from('organization_onboarding_documents')
    .select('id,document_type,object_file_id,created_at')
    .eq('submission_id', submissionId)
    .order('document_type');
  if (error) throw error;
  return data as OnboardingDocument[];
}

export async function reviewTenantOnboarding(input: {
  submissionId: string;
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';
  reviewNote: string;
}) {
  const { data, error } = await createClient().rpc('review_tenant_onboarding', {
    target_submission_id: input.submissionId,
    target_decision: input.decision,
    target_review_note: input.reviewNote.trim() || null,
    target_request_id: crypto.randomUUID(),
  });
  if (error) throw error;
  return data as { submission_id: string; organization_id: string; status: string };
}

type DownloadEnvelope = {
  ok: boolean;
  data: {
    download_url: string;
    expires_at: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
  } | null;
  error: { code: string; message: string } | null;
};

export async function createOnboardingDocumentDownload(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke<DownloadEnvelope>(
    'presign-download',
    { body: { object_file_id: objectFileId } },
  );
  if (error || !data?.ok || !data.data) throw error ?? new Error('DOCUMENT_DOWNLOAD_FAILED');
  return data.data;
}
