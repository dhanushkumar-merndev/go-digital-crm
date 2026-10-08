import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const pageSize = 25;

const auditLogIdSchema = z.union([
  z.string().regex(/^[1-9]\d*$/),
  z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, 'Audit log identity exceeds the safe integer range')
    .transform(String),
]);

const auditLogSchema = z.object({
  id: auditLogIdSchema,
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable(),
  actor_id: z.uuid().nullable(),
  branch_id: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export type AuditLogRecord = z.infer<typeof auditLogSchema>;
export type AuditLogCursor = Pick<AuditLogRecord, 'created_at' | 'id'>;

/** Page-local filter text; the RPC escapes LIKE wildcards server-side. */
function filterValue(value: string) {
  return value.trim().slice(0, 80);
}

/**
 * Reads through `get_audit_log_page`, not the table. The RLS policies check
 * permission once per row (12 s for 8 rows as Super Admin); the RPC applies the
 * same rules once per organization/branch and walks the (created_at, id) index.
 */
export async function fetchAuditLogPage(input: {
  cursor: AuditLogCursor | null;
  action: string;
  resource: string;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_audit_log_page', {
    target_action: filterValue(input.action),
    target_resource: filterValue(input.resource),
    cursor_created_at: input.cursor?.created_at ?? null,
    cursor_id: input.cursor ? Number(input.cursor.id) : null,
    page_limit: pageSize + 1,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  const records = z.array(auditLogSchema).parse(data ?? []);
  return { records: records.slice(0, pageSize), hasNext: records.length > pageSize };
}
