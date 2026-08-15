import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  isTestDriveVersionConflict,
  TestDriveVersionConflictError,
  testDriveViewValue,
  type TestDriveQuery,
} from './test-drive-workspace-query';

const nullableString = z.string().nullable();
const nullableUuid = z.uuid().nullable();
const nullableNumber = z.coerce.number().nullable();
const locationSchema = z
  .object({
    label: z.string().optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
  })
  .passthrough();

export const testDriveAnchorSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  recorded_at: z.string(),
});
export type TestDriveAnchor = z.infer<typeof testDriveAnchorSchema>;

export const testDriveRecordSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  appointment_id: z.uuid(),
  customer_id: z.uuid(),
  lead_id: nullableUuid,
  branch_id: z.uuid(),
  team_id: nullableUuid,
  assigned_user_id: z.uuid(),
  status: z.string(),
  version: z.coerce.number().int().positive(),
  scheduled_at: z.string(),
  expected_duration_minutes: z.coerce.number().int().positive(),
  stock_unit_id: nullableUuid,
  vehicle_registration: nullableString,
  start_location: locationSchema.nullable(),
  destination: locationSchema.nullable(),
  customer_name: z.string(),
  phone: nullableString,
  branch_name: z.string(),
  team_name: nullableString,
  assigned_user_name: z.string(),
  brand_name: nullableString,
  model_name: nullableString,
  variant_name: nullableString,
  vin: nullableString,
  chassis_number: nullableString,
  color: nullableString,
  started_at: nullableString,
  reached_at: nullableString,
  completed_at: nullableString,
  start_odometer: nullableNumber,
  end_odometer: nullableNumber,
  distance_meters: nullableNumber,
  duration_seconds: nullableNumber,
  start_anchor: testDriveAnchorSchema.nullable(),
  reached_anchor: testDriveAnchorSchema.nullable(),
  end_anchor: testDriveAnchorSchema.nullable(),
  route_finalized_at: nullableString,
  route_summary_id: nullableUuid,
  point_count: z.coerce.number().int().nonnegative().nullable(),
  feedback_id: nullableUuid,
  overall_rating: z.coerce.number().int().min(1).max(5).nullable(),
  purchase_intent: nullableString,
  cancelled_at: nullableString,
  cancellation_reason: nullableString,
  updated_at: z.string(),
  gps_status: z.string(),
  quotation_status: nullableString,
});
export type TestDriveRecord = z.infer<typeof testDriveRecordSchema>;

const testDriveWorkspaceSchema = z.object({
  records: z.array(testDriveRecordSchema),
  total: z.coerce.number().int().nonnegative(),
  organization_id: z.uuid(),
  timezone: z.string(),
  kpis: z.object({
    today: z.coerce.number().int().nonnegative(),
    overdue: z.coerce.number().int().nonnegative(),
    upcoming: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
    completed_this_month: z.coerce.number().int().nonnegative(),
    cancelled: z.coerce.number().int().nonnegative(),
    converted: z.coerce.number().int().nonnegative(),
  }),
});
export type TestDriveWorkspaceResult = z.infer<typeof testDriveWorkspaceSchema>;

export type TestDrivePermissions = {
  organizationId: string;
  userId: string;
  roleKey: string;
  scopeKey: string;
  canManage: boolean;
  canProgressOwn: boolean;
};

export async function fetchTestDrivePermissions(): Promise<TestDrivePermissions> {
  const supabase = createClient();
  const contextResponse = await supabase.rpc('get_access_context');
  if (contextResponse.error) throw contextResponse.error;
  const context = contextResponse.data as {
    destination?: string;
    user_id?: string;
    organization_id?: string;
    role_key?: string;
    data_scope?: string;
  } | null;
  if (
    context?.destination !== 'CRM' ||
    !context.user_id ||
    !context.organization_id ||
    !context.role_key
  )
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const [manageResponse, customerViewResponse] = await Promise.all([
    supabase.rpc('authorize_action', {
      target_organization_id: context.organization_id,
      target_permission: 'test_drive.manage',
      target_branch_id: null,
    }),
    supabase.rpc('authorize_action', {
      target_organization_id: context.organization_id,
      target_permission: 'customer.view',
      target_branch_id: null,
    }),
  ]);
  if (manageResponse.error) throw manageResponse.error;
  if (customerViewResponse.error) throw customerViewResponse.error;
  if (!manageResponse.data || !customerViewResponse.data)
    throw new Error('TEST_DRIVE_VIEW_PERMISSION_REQUIRED');
  return {
    organizationId: context.organization_id,
    userId: context.user_id,
    roleKey: context.role_key,
    scopeKey: `${context.role_key}:${context.data_scope ?? 'unknown'}`,
    canManage: true,
    canProgressOwn: context.role_key === 'sales-consultant',
  };
}

export async function fetchTestDriveWorkspace(
  query: TestDriveQuery,
  timezone: 'Asia/Kolkata' | 'UTC',
  signal?: AbortSignal,
): Promise<TestDriveWorkspaceResult> {
  const request = createClient().rpc('get_test_drive_workspace_page', {
    target_view: testDriveViewValue(query.view),
    target_search: query.search,
    target_model: query.model,
    target_from_date: query.fromDate || null,
    target_to_date: query.toDate || null,
    target_page: query.page,
    target_page_size: query.pageSize,
    target_sort: query.sort,
    target_timezone: timezone,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return testDriveWorkspaceSchema.parse(data);
}

const leadOptionSchema = z.object({
  lead_id: z.uuid(),
  customer_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: nullableUuid,
  assigned_user_id: z.uuid(),
  customer_name: z.string(),
  phone: nullableString,
  interested_model: nullableString,
  branch_name: z.string(),
  assigned_user_name: z.string(),
  updated_at: z.string(),
});
export type TestDriveLeadOption = z.infer<typeof leadOptionSchema>;

export async function fetchTestDriveLeadOptions(search = '', signal?: AbortSignal) {
  const request = createClient().rpc('get_test_drive_lead_options', {
    target_search: search.trim().slice(0, 160),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(leadOptionSchema).parse(data);
}

const vehicleOptionSchema = z.object({
  stock_unit_id: z.uuid(),
  branch_id: z.uuid(),
  vin: z.string(),
  chassis_number: z.string(),
  color: nullableString,
  brand_name: z.string(),
  model_name: z.string(),
  variant_name: z.string(),
  received_at: nullableString,
});
export type TestDriveVehicleOption = z.infer<typeof vehicleOptionSchema>;

export async function fetchTestDriveVehicleOptions(
  branchId: string,
  search = '',
  signal?: AbortSignal,
) {
  const request = createClient().rpc('get_test_drive_vehicle_options', {
    target_branch_id: branchId,
    target_search: search.trim().slice(0, 120),
    target_limit: 25,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return z.array(vehicleOptionSchema).parse(data);
}

const mutationResultSchema = z.object({
  id: z.uuid(),
  appointment_id: z.uuid().optional(),
  route_summary_id: z.uuid().optional(),
  feedback_id: z.uuid().optional(),
  version: z.coerce.number().int().positive(),
  status: z.string(),
  replayed: z.boolean(),
});
export type TestDriveMutationResult = z.infer<typeof mutationResultSchema>;

async function testDriveMutation(
  request: PromiseLike<{ data: unknown; error: unknown }>,
): Promise<TestDriveMutationResult> {
  const { data, error } = await request;
  if (error) {
    if (isTestDriveVersionConflict(error)) throw new TestDriveVersionConflictError();
    throw error;
  }
  return mutationResultSchema.parse(data);
}

export async function createTestDrive(input: {
  leadId: string;
  stockUnitId: string;
  scheduledAt: string;
  expectedDurationMinutes: number;
  vehicleRegistration: string;
  startLocation: { label: string } | null;
  destination: { label: string } | null;
  requestId: string;
}) {
  return testDriveMutation(
    createClient().rpc('create_test_drive', {
      target_lead_id: input.leadId,
      target_stock_unit_id: input.stockUnitId,
      target_scheduled_at: input.scheduledAt,
      target_expected_duration_minutes: input.expectedDurationMinutes,
      target_vehicle_registration: input.vehicleRegistration,
      target_start_location: input.startLocation,
      target_destination: input.destination,
      target_request_id: input.requestId,
    }),
  );
}

export async function cancelTestDrive(input: {
  testDriveId: string;
  expectedVersion: number;
  reason: string;
  requestId: string;
}) {
  return testDriveMutation(
    createClient().rpc('cancel_test_drive', {
      target_test_drive_id: input.testDriveId,
      expected_version: input.expectedVersion,
      target_reason: input.reason,
      target_request_id: input.requestId,
    }),
  );
}

export type TestDriveAnchorKind = 'start' | 'reached' | 'end';

export async function recordTestDriveAnchor(input: {
  testDriveId: string;
  kind: TestDriveAnchorKind;
  latitude: number;
  longitude: number;
  recordedAt: string;
  odometer: number | null;
  expectedVersion: number;
  requestId: string;
}) {
  return testDriveMutation(
    createClient().rpc('record_test_drive_anchor_v2', {
      target_test_drive_id: input.testDriveId,
      anchor_kind: input.kind,
      latitude: input.latitude,
      longitude: input.longitude,
      recorded_at: input.recordedAt,
      odometer: input.odometer,
      expected_version: input.expectedVersion,
      target_request_id: input.requestId,
    }),
  );
}

export type TestDriveRoutePoint = {
  sequenceNo: number;
  latitude: number;
  longitude: number;
  recordedAt: string;
};

export async function finalizeTestDriveRoute(input: {
  testDriveId: string;
  routePoints: TestDriveRoutePoint[];
  encodedPolyline?: string | null;
  expectedVersion: number;
  requestId: string;
}) {
  return testDriveMutation(
    createClient().rpc('finalize_test_drive_route_v2', {
      target_test_drive_id: input.testDriveId,
      route_points: input.routePoints,
      encoded_polyline: input.encodedPolyline ?? null,
      expected_version: input.expectedVersion,
      target_request_id: input.requestId,
    }),
  );
}

export async function saveTestDriveFeedback(input: {
  testDriveId: string;
  expectedVersion: number;
  drivingExperienceRating: number;
  comfortRating: number;
  featuresRating: number;
  performanceRating: number;
  pricePerceptionRating: number;
  overallRating: number;
  comments: string;
  competitorCompared: string;
  purchaseIntent: string;
  requestId: string;
}) {
  return testDriveMutation(
    createClient().rpc('save_test_drive_feedback', {
      target_test_drive_id: input.testDriveId,
      expected_version: input.expectedVersion,
      target_driving_experience_rating: input.drivingExperienceRating,
      target_comfort_rating: input.comfortRating,
      target_features_rating: input.featuresRating,
      target_performance_rating: input.performanceRating,
      target_price_perception_rating: input.pricePerceptionRating,
      target_overall_rating: input.overallRating,
      target_comments: input.comments || null,
      target_competitor_compared: input.competitorCompared || null,
      target_purchase_intent: input.purchaseIntent,
      target_request_id: input.requestId,
    }),
  );
}
