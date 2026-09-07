import type { SupabaseClient } from '@supabase/supabase-js';

/** Bounded in-app notifications; this job never sends a customer message. */
export async function runCrmAlerts(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('dispatch_crm_alerts', { target_batch_size: 200 });
  if (error) throw new Error('CRM_ALERT_DISPATCH_FAILED');
  return data as { lead_sla: number; customer_dates: number };
}
