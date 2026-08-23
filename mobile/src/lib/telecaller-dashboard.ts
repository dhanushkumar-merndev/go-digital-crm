import { supabase } from './supabase';

export type MobileTelecallerDashboard = {
  kpis: {
    openLeads: number;
    newLeadsToday: number;
    followupsToday: number;
    followupsOverdue: number;
    callsToday: number;
    appointmentsToday: number;
  };
  attention: Array<{ title: string; detail: string; severity: 'HIGH' | 'MEDIUM' }>;
  recentLeads: Array<{
    id: string;
    customerName: string;
    phone: string;
    source: string;
    interestedModel: string | null;
    lifecycleStatus: string;
    temperature: 'COLD' | 'WARM' | 'HOT' | null;
  }>;
};

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function string(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export async function fetchMobileTelecallerDashboard(): Promise<MobileTelecallerDashboard> {
  const { data, error } = await supabase.rpc('get_tenant_performance_dashboard', {
    target_days: 7,
    target_timezone: 'Asia/Kolkata',
  });
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  const kpis = (raw.kpis ?? {}) as Record<string, unknown>;
  return {
    kpis: {
      openLeads: number(kpis.open_leads),
      newLeadsToday: number(kpis.new_leads_today),
      followupsToday: number(kpis.followups_due_today),
      followupsOverdue: number(kpis.followups_overdue),
      callsToday: number(kpis.calls_today),
      appointmentsToday: number(kpis.appointments_today),
    },
    attention: Array.isArray(raw.attention)
      ? raw.attention.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const value = item as Record<string, unknown>;
          const severity = string(value.severity);
          return [
            {
              title: string(value.title),
              detail: string(value.detail),
              severity: severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
            },
          ];
        })
      : [],
    recentLeads: Array.isArray(raw.lead_preview)
      ? raw.lead_preview.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const value = item as Record<string, unknown>;
          const temperature = string(value.temperature);
          return [
            {
              id: string(value.id),
              customerName: string(value.customer_name),
              phone: string(value.phone),
              source: string(value.source),
              interestedModel:
                typeof value.interested_model === 'string' ? value.interested_model : null,
              lifecycleStatus: string(value.lifecycle_status),
              temperature:
                temperature === 'HOT' || temperature === 'WARM' || temperature === 'COLD'
                  ? temperature
                  : null,
            },
          ];
        })
      : [],
  };
}
