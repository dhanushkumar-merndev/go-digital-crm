import { supabase } from '@/lib/supabase';

export type TestDriveView = 'TODAY' | 'UPCOMING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export type TestDriveRecord = {
  id: string;
  version: number;
  status: 'READY' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  customer_name: string;
  phone: string;
  scheduled_at: string;
  expected_duration_minutes: number;
  branch_name: string;
  team_name: string | null;
  assigned_user_name: string;
  brand_name: string | null;
  model_name: string | null;
  variant_name: string | null;
  vehicle_registration: string | null;
  vin: string | null;
  reached_at: string | null;
  completed_at: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  gps_status: 'NOT_STARTED' | 'ANCHORS_ONLY_ACTIVE' | 'ROUTE_UPLOAD_PENDING' | 'ROUTE_FINALIZED';
  route_summary_id: string | null;
  point_count: number | null;
  feedback_id: string | null;
  overall_rating: number | null;
  purchase_intent: string | null;
};

export type TestDrivePage = {
  records: TestDriveRecord[];
  total: number;
  timezone: string;
  kpis: {
    today: number;
    overdue: number;
    upcoming: number;
    active: number;
    completed_this_month: number;
    cancelled: number;
    converted: number;
  };
};

export type TestDriveFeedback = {
  drivingExperienceRating: number;
  comfortRating: number;
  featuresRating: number;
  performanceRating: number;
  pricePerceptionRating: number;
  overallRating: number;
  comments: string;
  competitorCompared: string;
  purchaseIntent: 'HIGHLY_INTERESTED' | 'INTERESTED' | 'CONSIDERING' | 'NOT_INTERESTED';
};

function isPage(value: unknown): value is TestDrivePage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TestDrivePage>;
  return (
    Array.isArray(candidate.records) &&
    typeof candidate.total === 'number' &&
    Boolean(candidate.kpis) &&
    typeof candidate.kpis?.today === 'number' &&
    typeof candidate.kpis?.overdue === 'number'
  );
}

export async function loadTestDrivePage(view: TestDriveView) {
  const { data, error } = await supabase.rpc('get_test_drive_workspace_page', {
    target_view: view,
    target_search: '',
    target_model: '',
    target_from_date: null,
    target_to_date: null,
    target_page: 1,
    target_page_size: 25,
    target_sort: view === 'COMPLETED' ? 'updated:desc' : 'scheduled:asc',
    target_timezone: 'Asia/Kolkata',
  });
  if (error) throw error;
  if (!isPage(data)) throw new Error('INVALID_TEST_DRIVE_RESPONSE');
  return data;
}

export async function saveTestDriveFeedback(
  testDriveId: string,
  expectedVersion: number,
  feedback: TestDriveFeedback,
) {
  const { data, error } = await supabase.rpc('save_test_drive_feedback', {
    target_test_drive_id: testDriveId,
    expected_version: expectedVersion,
    target_driving_experience_rating: feedback.drivingExperienceRating,
    target_comfort_rating: feedback.comfortRating,
    target_features_rating: feedback.featuresRating,
    target_performance_rating: feedback.performanceRating,
    target_price_perception_rating: feedback.pricePerceptionRating,
    target_overall_rating: feedback.overallRating,
    target_comments: feedback.comments,
    target_competitor_compared: feedback.competitorCompared,
    target_purchase_intent: feedback.purchaseIntent,
    target_request_id: createRequestId(),
  });
  if (error) throw error;
  return data;
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
