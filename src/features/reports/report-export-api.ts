import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import type { ReportExportQuery, ReportKind } from './report-export-query';

const nullableUuid = z.uuid().nullable();
const recordSchema = z.object({
  id: z.uuid(),
  report_key: z.string(),
  branch_id: nullableUuid,
  requested_by: z.uuid(),
  requested_by_name: z.string().nullable(),
  status: z.enum(['QUEUED', 'PROCESSING', 'READY', 'RETRY', 'FAILED', 'EXPIRED', 'CANCELLED']),
  object_file_id: nullableUuid,
  safe_error_code: z.string().nullable(),
  expires_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});
export type ReportExportRecord = z.infer<typeof recordSchema>;
const chartDatum = z.object({ name: z.string(), value: z.coerce.number().nonnegative() });
const pageSchema = z.object({
  organization_id: z.uuid(),
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    ready: z.coerce.number().int().nonnegative(),
    processing: z.coerce.number().int().nonnegative(),
    failed: z.coerce.number().int().nonnegative(),
    requested_30d: z.coerce.number().int().nonnegative(),
  }),
  status_chart: z.array(chartDatum),
});
export type ReportExportsPage = z.infer<typeof pageSchema>;

export async function fetchReportExports(query: ReportExportQuery, signal?: AbortSignal) {
  const request = createClient().rpc('get_report_exports_page', {
    target_search: query.search,
    target_page: query.page,
    target_page_size: query.pageSize,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return pageSchema.parse(data);
}

export async function fetchReportPermissions() {
  const supabase = createClient();
  const { data: context, error } = await supabase.rpc('get_access_context');
  if (error) throw error;
  const access = context as { destination?: string; organization_id?: string } | null;
  if (access?.destination !== 'CRM' || !access.organization_id)
    throw new Error('CRM_ACCESS_CONTEXT_UNAVAILABLE');
  const { data: canExport, error: permissionError } = await supabase.rpc('authorize_action', {
    target_organization_id: access.organization_id,
    target_permission: 'report.export',
    target_branch_id: null,
  });
  if (permissionError) throw permissionError;
  return { organizationId: access.organization_id, canExport: Boolean(canExport) };
}

const requestResult = z.object({ id: z.uuid(), status: z.string(), replayed: z.boolean() });
export async function requestReportExport(reportKey: ReportKind) {
  const { data, error } = await createClient().rpc('request_report_export', {
    target_report_key: reportKey,
    target_branch_id: null,
    target_request_id: crypto.randomUUID(),
  });
  if (error) throw error;
  return requestResult.parse(data);
}
const downloadResponse = z.object({ download_url: z.url(), expires_at: z.string() });
export async function presignReportDownload(objectFileId: string) {
  const { data, error } = await createClient().functions.invoke('presign-download', {
    body: { object_file_id: objectFileId },
  });
  if (error) throw error;
  return z.object({ data: downloadResponse }).parse(data).data;
}
