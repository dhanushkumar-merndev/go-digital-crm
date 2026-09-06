import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const templateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  channel: z.string(),
  content: z.record(z.string(), z.unknown()),
  provider_template_id: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by_name: z.string(),
});

const workspaceSchema = z.object({
  records: z.array(templateSchema),
  total: z.coerce.number().int().nonnegative(),
  kpis: z.object({
    total: z.coerce.number().int().nonnegative(),
    draft: z.coerce.number().int().nonnegative(),
    approved: z.coerce.number().int().nonnegative(),
    attention: z.coerce.number().int().nonnegative(),
  }),
});

export type TemplateRecord = z.infer<typeof templateSchema>;
export type TemplateWorkspaceQuery = {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  channel: 'ALL' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'WHATSAPP_BUSINESS';
  status: 'ALL' | 'DRAFT' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
};

export async function fetchTemplateWorkspace(query: TemplateWorkspaceQuery) {
  const { data, error } = await createClient().rpc('get_template_workspace', {
    target_page: query.page,
    target_page_size: query.pageSize,
    target_search: query.search.trim().slice(0, 100) || null,
    target_channel: query.channel,
    target_status: query.status,
  });
  if (error) throw error;
  return workspaceSchema.parse(data);
}

export async function createDraftTemplate(input: {
  name: string;
  channel: Exclude<TemplateWorkspaceQuery['channel'], 'ALL'>;
  body: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_draft_template', {
    target_name: input.name,
    target_channel: input.channel,
    target_body: input.body,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z.object({ id: z.uuid(), status: z.literal('DRAFT') }).parse(data);
}

export async function archiveTemplate(templateId: string) {
  const { error } = await createClient().rpc('archive_template', {
    target_template_id: templateId,
  });
  if (error) throw error;
}

const approvalSchema = z.object({
  id: z.uuid(),
  status: z.literal('APPROVED'),
  provider_template_id: z.string(),
  replayed: z.boolean(),
});

/**
 * Records an approval the provider already granted. `providerTemplateId` is the
 * id from Brevo or Meta, not one this system mints: send-email and send-message
 * both look a template up by it, so an inaccurate value here is only discovered
 * at send time.
 */
export async function approveTemplate(input: {
  templateId: string;
  providerTemplateId: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('approve_template', {
    target_template_id: input.templateId,
    target_provider_template_id: input.providerTemplateId.trim(),
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return approvalSchema.parse(data);
}

export async function rejectTemplate(input: {
  templateId: string;
  reason: string;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('reject_template', {
    target_template_id: input.templateId,
    target_reason: input.reason.trim(),
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return z.object({ id: z.uuid(), status: z.literal('REJECTED') }).parse(data);
}
