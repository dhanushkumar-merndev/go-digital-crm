import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const contextSchema = z.object({
  destination: z.string(),
  tenant_status: z.string().nullable().optional(),
  role_key: z.string().nullable().optional(),
  data_scope: z.string().nullable().optional(),
  mfa_required: z.boolean().optional(),
  mfa_satisfied: z.boolean().optional(),
  support_controller: z.boolean().optional(),
});
const auditLogIdSchema = z.union([
  z.string().regex(/^[1-9]\d*$/),
  z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, 'Audit log identity exceeds the safe integer range')
    .transform(String),
]);
const auditSchema = z.object({
  id: auditLogIdSchema,
  action: z.string(),
  resource_type: z.string(),
  created_at: z.string(),
});

export async function fetchSecurityPosture(signal?: AbortSignal) {
  const supabase = createClient();
  const contextRequest = supabase.rpc('get_access_context');
  const auditRequest = supabase
    .from('audit_logs')
    .select('id,action,resource_type,created_at')
    .order('created_at', { ascending: false })
    .limit(8);
  const [contextResponse, auditResponse, assuranceResponse] = await Promise.all([
    signal ? contextRequest.abortSignal(signal) : contextRequest,
    signal ? auditRequest.abortSignal(signal) : auditRequest,
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (contextResponse.error) throw contextResponse.error;
  if (auditResponse.error) throw auditResponse.error;
  if (assuranceResponse.error) throw assuranceResponse.error;
  return {
    context: contextSchema.parse(contextResponse.data),
    auditEvents: z.array(auditSchema).parse(auditResponse.data ?? []),
    assurance: {
      currentLevel: assuranceResponse.data?.currentLevel ?? 'aal1',
      nextLevel: assuranceResponse.data?.nextLevel ?? 'aal1',
    },
  };
}
