import { createClient } from '@/lib/supabase/client';
import {
  normalizeRetentionSearch,
  retentionSortValues,
  retentionStatusValues,
  type RetentionQuery,
} from './retention-query';

export type RetentionRequestStatus =
  | 'PENDING'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PURGING'
  | 'FAILED'
  | 'RESTORED'
  | 'REJECTED'
  | 'PURGED';

export type RetentionRecord = {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  status: RetentionRequestStatus;
  original_status: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_by_name: string | null;
  requested_by: string;
  requested_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  reason: string;
  requested_at: string;
  approved_at: string | null;
  purge_after: string;
  retention_days: number;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  legal_hold_at: string | null;
  failure_safe_code: string | null;
  restored_at: string | null;
  purge_started_at: string | null;
  purge_job_id: string | null;
  purge_job_status: string | null;
  purge_attempts: number | null;
  purge_last_error_code: string | null;
  manifest_id: string | null;
  manifest_status: string | null;
  manifest_checksum: string | null;
  manifest_summary: {
    external_provider_connection_count?: number;
    external_provider_token_revocation?: string;
    purge_scope?: string;
  } | null;
  purge_completed_at: string | null;
};

export type RetentionKpis = {
  awaiting_approval: number;
  scheduled: number;
  on_hold: number;
  attention: number;
};

export type RetentionResult = {
  records: RetentionRecord[];
  total: number;
  kpis: RetentionKpis;
};

export type RetentionTenantOption = {
  id: string;
  name: string;
  slug: string;
  status: string;
};

type RetentionWorkspaceEnvelope = {
  records?: RetentionRecord[];
  total?: number | string;
  kpis?: Partial<Record<keyof RetentionKpis, number | string | null>>;
};

function numberOrZero(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function fetchRetentionWorkspace(query: RetentionQuery): Promise<RetentionResult> {
  const { data, error } = await createClient().rpc('get_platform_retention_workspace', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: normalizeRetentionSearch(query.search),
    target_status: retentionStatusValues[query.status],
    target_sort: retentionSortValues[query.sort],
  });
  if (error) throw error;
  const result = (data ?? {}) as RetentionWorkspaceEnvelope;
  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: numberOrZero(result.total),
    kpis: {
      awaiting_approval: numberOrZero(result.kpis?.awaiting_approval),
      scheduled: numberOrZero(result.kpis?.scheduled),
      on_hold: numberOrZero(result.kpis?.on_hold),
      attention: numberOrZero(result.kpis?.attention),
    },
  };
}

export async function fetchRetentionTenantOptions(search: string) {
  const { data, error } = await createClient().rpc('get_platform_retention_tenant_options', {
    target_search: normalizeRetentionSearch(search),
  });
  if (error) throw error;
  return (data ?? []) as RetentionTenantOption[];
}

export async function requestTenantDeletion(input: {
  organizationId: string;
  reason: string;
  retentionDays: number;
  idempotencyKey: string;
}) {
  const { data, error } = await createClient().rpc('request_tenant_deletion', {
    target_organization_id: input.organizationId,
    deletion_reason: input.reason.trim(),
    retention_days: input.retentionDays,
    request_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return data as RetentionRecord;
}

export async function reviewTenantDeletion(input: {
  requestId: string;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}) {
  const { data, error } = await createClient().rpc('review_tenant_deletion', {
    target_deletion_request_id: input.requestId,
    target_decision: input.decision,
    decision_reason: input.reason.trim(),
  });
  if (error) throw error;
  return data as RetentionRecord;
}

export async function restoreSoftDeletedTenant(input: { requestId: string; reason: string }) {
  const { data, error } = await createClient().rpc('restore_soft_deleted_tenant', {
    target_deletion_request_id: input.requestId,
    restore_reason: input.reason.trim(),
  });
  if (error) throw error;
  return data as RetentionRecord;
}

export async function setTenantDeletionLegalHold(input: {
  requestId: string;
  enabled: boolean;
  reason: string;
}) {
  const { data, error } = await createClient().rpc('set_tenant_deletion_legal_hold', {
    target_deletion_request_id: input.requestId,
    hold_enabled: input.enabled,
    hold_reason: input.reason.trim(),
  });
  if (error) throw error;
  return data as RetentionRecord;
}

export async function extendTenantRetention(input: {
  requestId: string;
  purgeAfter: string;
  reason: string;
}) {
  const { data, error } = await createClient().rpc('extend_tenant_retention', {
    target_deletion_request_id: input.requestId,
    target_purge_after: input.purgeAfter,
    extension_reason: input.reason.trim(),
  });
  if (error) throw error;
  return data as RetentionRecord;
}

export async function requeueFailedTenantPurge(input: { requestId: string; reason: string }) {
  const { data, error } = await createClient().rpc('requeue_failed_tenant_purge', {
    target_deletion_request_id: input.requestId,
    requeue_reason: input.reason.trim(),
  });
  if (error) throw error;
  return data as { id: string; status: string };
}
