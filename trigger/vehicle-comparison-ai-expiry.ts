import type { SupabaseClient } from '@supabase/supabase-js';

export async function runVehicleComparisonAiExpiry(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('expire_vehicle_comparison_ai');
  if (error) throw error;
  return { refunded: data ?? 0 };
}
