import { supabase } from './supabase';

export type MobileSalesDashboard = {
  generatedAt: string;
  metrics: {
    leadsAssignedToday: number;
    hotLeads: number;
    followupsToday: number;
    callsPending: number;
    testDrivesToday: number;
    quotationsPending: number;
    bookingsMonth: number;
    targetAchievement: number;
  };
  attention: Array<{ key: string; value: number }>;
  schedule: Array<{
    id: string;
    kind: 'FOLLOW_UP' | 'SHOWROOM_VISIT' | 'TEST_DRIVE' | 'DELIVERY';
    scheduledAt: string;
    customerName: string;
    detail: string | null;
    status: string;
  }>;
  recentLeads: Array<{
    id: string;
    reference: string;
    customerName: string;
    phone: string;
    interestedModel: string | null;
    nextFollowupAt: string | null;
    source: string;
    lifecycleStatus: string;
    temperature: 'COLD' | 'WARM' | 'HOT' | null;
  }>;
};

type Metric = { value?: unknown };
type RawResult = {
  generated_at?: unknown;
  metrics?: Record<string, Metric>;
  attention?: unknown;
  schedule?: unknown;
  recent_leads?: unknown;
};

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function metric(result: RawResult, key: string) {
  return asNumber(result.metrics?.[key]?.value);
}

export async function fetchMobileSalesDashboard(): Promise<MobileSalesDashboard> {
  const { data, error } = await supabase.functions.invoke('sales-consultant-dashboard', {
    body: { manual_refresh: false },
  });
  if (error) throw error;
  const envelope = data as { ok?: unknown; data?: { result?: RawResult } } | null;
  const result = envelope?.ok === true ? envelope.data?.result : null;
  if (!result) throw new Error('MOBILE_SALES_DASHBOARD_INVALID');
  return {
    generatedAt: asString(result.generated_at),
    metrics: {
      leadsAssignedToday: metric(result, 'leads_assigned_today'),
      hotLeads: metric(result, 'hot_leads'),
      followupsToday: metric(result, 'followups_today'),
      callsPending: metric(result, 'calls_pending'),
      testDrivesToday: metric(result, 'test_drives_today'),
      quotationsPending: metric(result, 'quotations_pending'),
      bookingsMonth: metric(result, 'bookings_month'),
      targetAchievement: metric(result, 'target_achievement'),
    },
    attention: array(result.attention).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as { key?: unknown; value?: unknown };
      return [{ key: asString(value.key), value: asNumber(value.value) }];
    }),
    schedule: array(result.schedule).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const kind = asString(value.kind);
      if (!['FOLLOW_UP', 'SHOWROOM_VISIT', 'TEST_DRIVE', 'DELIVERY'].includes(kind)) return [];
      return [
        {
          id: asString(value.id),
          kind: kind as MobileSalesDashboard['schedule'][number]['kind'],
          scheduledAt: asString(value.scheduled_at),
          customerName: asString(value.customer_name),
          detail: typeof value.detail === 'string' ? value.detail : null,
          status: asString(value.status),
        },
      ];
    }),
    recentLeads: array(result.recent_leads).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const temperature = asString(value.temperature);
      return [
        {
          id: asString(value.id),
          reference: asString(value.reference),
          customerName: asString(value.customer_name),
          phone: asString(value.phone),
          interestedModel:
            typeof value.interested_model === 'string' ? value.interested_model : null,
          nextFollowupAt:
            typeof value.next_followup_at === 'string' ? value.next_followup_at : null,
          source: asString(value.source),
          lifecycleStatus: asString(value.lifecycle_status),
          temperature:
            temperature === 'HOT' || temperature === 'WARM' || temperature === 'COLD'
              ? temperature
              : null,
        },
      ];
    }),
  };
}
