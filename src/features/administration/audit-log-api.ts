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

function filterValue(value: string) {
  return value
    .trim()
    .slice(0, 80)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

export async function fetchAuditLogPage(input: {
  cursor: AuditLogCursor | null;
  action: string;
  resource: string;
  signal?: AbortSignal;
}) {
  const action = filterValue(input.action);
  const resource = filterValue(input.resource);
  let request = createClient()
    .from('audit_logs')
    .select('id,action,resource_type,resource_id,actor_id,branch_id,metadata,created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageSize + 1);
  if (action) request = request.ilike('action', `%${action}%`);
  if (resource) request = request.ilike('resource_type', `%${resource}%`);
  if (input.cursor) {
    request = request.or(
      `created_at.lt.${input.cursor.created_at},and(created_at.eq.${input.cursor.created_at},id.lt.${input.cursor.id})`,
    );
  }
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  const records = z.array(auditLogSchema).parse(data ?? []);
  return { records: records.slice(0, pageSize), hasNext: records.length > pageSize };
}
