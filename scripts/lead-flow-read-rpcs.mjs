// Shared by capture and replay. Review the RPC's implementation before adding
// it: a get_ prefix does not imply a read (e.g. get_or_create_pdi_inspection).
const readRpcs = new Set([
  'get_active_call_status',
  'get_appointment_calendar',
  'get_appointment_type_summary',
  'get_appointment_workspace_page',
  'get_booking_quotation_options',
  'get_customer_360',
  'get_customer_additional_fields',
  'get_followup_workspace_filtered_page',
  'get_interested_model_options',
  'get_inventory_booking_options',
  'get_lead_assignment_candidates',
  'get_lead_detail_workspace',
  'get_lead_open_followup',
  'get_lead_phone_history',
  'get_lead_workspace_page_v2',
  'get_my_credit_balance',
  'get_my_followup_reminders',
  'get_my_lead_preferences',
  'get_operational_case_booking_options',
  'get_operational_case_detail',
  'get_operational_case_workspace_page',
  'get_quotation_lead_options',
  'get_quotation_workspace_page',
  'get_sales_booking_filter_options',
  'get_sales_booking_workspace_page',
  'get_sales_handoff_candidates',
  'get_stock_check_filter_options',
  'get_stock_unit_detail',
  'get_stock_unit_page',
  'get_test_drive_lead_options',
  'get_test_drive_vehicle_options',
  'get_test_drive_workspace_page',
]);

export function isLeadFlowReadRpc(api) {
  return readRpcs.has(api);
}
