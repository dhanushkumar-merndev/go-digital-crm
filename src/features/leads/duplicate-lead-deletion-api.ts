import { createClient } from '@/lib/supabase/client';

export type DuplicateDeletionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type DuplicateDeletionRequest = {
  id: string;
  status: DuplicateDeletionStatus;
  reason: string;
  review_note: string | null;
  requested_at: string;
  decided_at: string | null;
  lead_id: string;
  customer_name: string;
  phone: string;
  source: string;
  interested_model: string | null;
  lifecycle_status: string;
  branch_id: string;
  team_id: string | null;
  branch_name: string;
  team_name: string | null;
  retained_lead_id: string;
  retained_customer_name: string;
  retained_source: string;
  retained_lifecycle_status: string;
  retained_created_at: string;
  requester_name: string;
  reviewer_name: string | null;
};

export type DuplicateDeletionPage = {
  records: DuplicateDeletionRequest[];
  total: number;
  page: number;
  page_size: number;
};

export async function requestDuplicateLeadDeletion(input: { leadId: string; reason: string }) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('request_duplicate_lead_deletion', {
    target_lead_id: input.leadId,
    target_reason: input.reason,
  });
  if (error) throw error;
  return data as {
    request_id: string;
    lead_id: string;
    retained_lead_id: string;
    status: 'PENDING';
    requested_at: string;
  };
}

export async function fetchDuplicateLeadDeletionRequests(
  input: {
    status: DuplicateDeletionStatus;
    search: string;
    page: number;
    pageSize: 25 | 50 | 100;
  },
  signal?: AbortSignal,
): Promise<DuplicateDeletionPage> {
  const supabase = createClient();
  const request = supabase.rpc('get_duplicate_lead_deletion_requests', {
    target_status: input.status,
    target_search: input.search,
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  const result = data as Partial<DuplicateDeletionPage> | null;
  return {
    records: Array.isArray(result?.records) ? (result.records as DuplicateDeletionRequest[]) : [],
    total: Number(result?.total ?? 0),
    page: Number(result?.page ?? input.page),
    page_size: Number(result?.page_size ?? input.pageSize),
  };
}

export async function decideDuplicateLeadDeletion(input: {
  requestId: string;
  decision: 'APPROVED' | 'REJECTED';
  reviewNote: string;
}) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('decide_duplicate_lead_deletion', {
    target_request_id: input.requestId,
    target_decision: input.decision,
    target_review_note: input.reviewNote || null,
  });
  if (error) throw error;
  return data as {
    request_id: string;
    lead_id: string;
    retained_lead_id: string;
    status: 'APPROVED' | 'REJECTED';
    soft_deleted: boolean;
  };
}
