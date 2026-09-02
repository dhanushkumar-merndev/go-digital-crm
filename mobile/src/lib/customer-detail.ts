import { supabase } from '@/lib/supabase';

type Customer360Access = {
  overview: boolean;
  leads: boolean;
  calls: boolean;
  followups: boolean;
  appointments: boolean;
  test_drives: boolean;
  quotations: boolean;
  bookings: boolean;
  timeline: boolean;
};

export type MobileCustomerDetail = {
  customer: {
    id: string;
    full_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    created_at: string;
    updated_at: string;
  };
  current_opportunity: {
    id: string;
    source: string;
    interested_model: string | null;
    lifecycle_status: string;
    temperature: 'COLD' | 'WARM' | 'HOT' | 'DORMANT' | null;
    work_state: 'NEW_TODAY' | 'PENDING' | 'SLA_RISK' | null;
    branch_name: string;
    team_name: string | null;
    assigned_user_name: string | null;
    updated_at: string;
  } | null;
  section_access: Customer360Access;
  calls: Array<{
    id: string;
    started_at: string;
    duration_seconds: number | null;
    outcome: string | null;
    status: string;
  }>;
  followups: Array<{
    id: string;
    lead_id: string | null;
    reason: string;
    due_at: string;
    status: string;
    assigned_user_name: string | null;
  }>;
  appointments: Array<{
    id: string;
    appointment_type: string;
    scheduled_at: string;
    status: string;
    branch_name: string;
  }>;
  quotations: Array<{
    id: string;
    quotation_number: string;
    status: string;
    total_amount: number | null;
  }>;
  bookings: Array<{
    id: string;
    booking_number: string;
    status: string;
    total_value: number | null;
  }>;
  timeline: Array<{
    id: string;
    activity_type: string;
    actor_name: string | null;
    occurred_at: string;
  }>;
};

export async function fetchMobileCustomerDetail(customerId: string): Promise<MobileCustomerDetail> {
  const { data, error } = await supabase.rpc('get_customer_360', {
    target_customer_id: customerId,
  });
  if (error || !data) throw error ?? new Error('CUSTOMER_NOT_FOUND');
  return data as unknown as MobileCustomerDetail;
}
