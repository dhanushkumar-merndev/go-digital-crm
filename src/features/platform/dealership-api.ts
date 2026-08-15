import { createClient } from '@/lib/supabase/client';
import { assertPlatformReviewAccess } from './onboarding-review-api';
import {
  dealershipSortOptions,
  dealershipStatusValues,
  toDealershipSearchTerm,
  type DealershipQuery,
} from './dealership-query';

export type DealershipRecord = {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  gst_number: string | null;
  status:
    | 'ONBOARDING'
    | 'UNDER_REVIEW'
    | 'CHANGES_REQUIRED'
    | 'ACTIVE'
    | 'SUPPORT_MAINTENANCE'
    | 'SUSPENDED'
    | 'REJECTED'
    | 'SOFT_DELETED';
  primary_owner_id: string | null;
  created_at: string;
  updated_at: string;
  owner_name: string | null;
  owner_email: string | null;
};

export type DealershipKpis = {
  total: number;
  active: number;
  onboarding: number;
  attention: number;
};

export type DealershipResult = {
  records: DealershipRecord[];
  total: number;
  kpis: DealershipKpis;
};

type RawDealership = Omit<DealershipRecord, 'owner_name' | 'owner_email'>;
type OwnerProfile = { id: string; full_name: string; email: string };

export async function fetchDealerships(query: DealershipQuery): Promise<DealershipResult> {
  await assertPlatformReviewAccess();
  const supabase = createClient();
  const sort = dealershipSortOptions[query.sort];
  let listQuery = supabase
    .from('organizations')
    .select('id,name,slug,legal_name,gst_number,status,primary_owner_id,created_at,updated_at', {
      count: 'exact',
    })
    .is('deleted_at', null)
    .order(sort.column, { ascending: sort.ascending })
    .order('id', { ascending: sort.ascending })
    .range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1);
  if (query.status !== 'all')
    listQuery = listQuery.eq('status', dealershipStatusValues[query.status]);
  if (query.search) {
    const term = toDealershipSearchTerm(query.search);
    if (term)
      listQuery = listQuery.or(
        `name.ilike.%${term}%,legal_name.ilike.%${term}%,slug.ilike.%${term}%,gst_number.ilike.%${term}%`,
      );
  }

  const [listResponse, kpiResponse] = await Promise.all([
    listQuery,
    supabase.rpc('get_platform_dealership_kpis'),
  ]);
  if (listResponse.error) throw listResponse.error;
  if (kpiResponse.error) throw kpiResponse.error;
  const rawRecords = (listResponse.data ?? []) as RawDealership[];
  const ownerIds = [
    ...new Set(
      rawRecords.flatMap((record) => (record.primary_owner_id ? [record.primary_owner_id] : [])),
    ),
  ];
  let ownerById = new Map<string, OwnerProfile>();
  if (ownerIds.length) {
    const owners = await supabase.from('profiles').select('id,full_name,email').in('id', ownerIds);
    if (owners.error) throw owners.error;
    ownerById = new Map((owners.data as OwnerProfile[]).map((owner) => [owner.id, owner]));
  }
  const rawKpis = (kpiResponse.data?.[0] ?? {}) as Partial<
    Record<keyof DealershipKpis, string | number | null>
  >;
  return {
    records: rawRecords.map((record) => ({
      ...record,
      owner_name: record.primary_owner_id
        ? (ownerById.get(record.primary_owner_id)?.full_name ?? null)
        : null,
      owner_email: record.primary_owner_id
        ? (ownerById.get(record.primary_owner_id)?.email ?? null)
        : null,
    })),
    total: listResponse.count ?? 0,
    kpis: {
      total: Number(rawKpis.total ?? 0),
      active: Number(rawKpis.active ?? 0),
      onboarding: Number(rawKpis.onboarding ?? 0),
      attention: Number(rawKpis.attention ?? 0),
    },
  };
}

type ProvisionEnvelope = {
  ok: boolean;
  data: {
    organization_id: string;
    owner_user_id: string;
    status: string;
    invite_status: string;
  } | null;
  error: { code: string; message: string } | null;
};

export async function provisionDealership(input: {
  organizationName: string;
  organizationSlug: string;
  legalName: string;
  gstNumber: string;
  ownerName: string;
  ownerEmail: string;
}) {
  const { data, error } = await createClient().functions.invoke<ProvisionEnvelope>(
    'tenant-provision',
    {
      body: {
        organization_name: input.organizationName,
        organization_slug: input.organizationSlug,
        legal_name: input.legalName.trim() || undefined,
        gst_number: input.gstNumber.trim() || undefined,
        owner_name: input.ownerName,
        owner_email: input.ownerEmail,
      },
    },
  );
  if (error || !data?.ok || !data.data)
    throw error ?? new Error(data?.error?.code ?? 'TENANT_PROVISION_FAILED');
  return data.data;
}
