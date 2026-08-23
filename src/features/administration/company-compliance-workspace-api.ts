import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const documentSchema = z.object({
  document_type: z.enum(['OWNER_IDENTITY', 'GST_CERTIFICATE', 'DEALERSHIP_AUTHORIZATION']),
  uploaded_at: z.string(),
  mime_type: z.string().min(1),
  size_bytes: z.coerce.number().int().nonnegative(),
});

const workspaceSchema = z.object({
  organization: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    legal_name: z.string().nullable(),
    gst_number: z.string().nullable(),
    status: z.string().min(1),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  branch_summary: z.object({
    total: z.coerce.number().int().nonnegative(),
    active: z.coerce.number().int().nonnegative(),
  }),
  latest_submission: z
    .object({
      version: z.coerce.number().int().positive(),
      organization_name: z.string().min(1),
      legal_name: z.string().min(1),
      gst_number: z.string().min(1),
      dealer_information: z.object({
        registered_address: z.string().optional(),
        dealership_license_number: z.string().optional(),
        manufacturer_names: z.array(z.string()).optional(),
        contact_phone: z.string().optional(),
        contact_email: z.string().optional(),
      }),
      status: z.enum(['SUBMITTED', 'CHANGES_REQUIRED', 'APPROVED', 'REJECTED']),
      submitted_at: z.string(),
      reviewed_at: z.string().nullable(),
      review_note: z.string().nullable(),
      evidence: z.array(documentSchema),
    })
    .nullable(),
  status_history: z.array(
    z.object({
      from_status: z.string().nullable(),
      to_status: z.string().min(1),
      reason: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

export type CompanyComplianceWorkspace = z.infer<typeof workspaceSchema>;

export async function fetchCompanyComplianceWorkspace(signal?: AbortSignal) {
  const request = createClient().rpc('get_tenant_company_compliance_workspace');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return workspaceSchema.parse(data);
}
