import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const fieldTypes = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT'] as const;
const statusFilters = ['ALL', 'ACTIVE', 'INACTIVE'] as const;
const pageSizes = [25, 50, 100] as const;

const recordSchema = z.object({
  id: z.uuid(),
  module: z.string(),
  field_key: z.string(),
  label: z.string(),
  field_type: z.enum(fieldTypes),
  options: z.array(z.unknown()),
  required: z.boolean(),
  active: z.boolean(),
  version: z.coerce.number().int().positive(),
});
const pageSchema = z.object({
  records: z.array(recordSchema),
  total: z.coerce.number().int().nonnegative(),
  active_count: z.coerce.number().int().nonnegative(),
  inactive_count: z.coerce.number().int().nonnegative(),
});
const mutationResultSchema = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  active: z.boolean(),
  replayed: z.boolean(),
});

export type CustomFieldType = (typeof fieldTypes)[number];
export type CustomFieldStatus = (typeof statusFilters)[number];
export type CustomFieldPageSize = (typeof pageSizes)[number];
export type CustomFieldRecord = z.infer<typeof recordSchema>;
export const customFieldTypes = fieldTypes;
export const customFieldStatuses = statusFilters;
export const customFieldPageSizes = pageSizes;

export async function fetchCustomFieldPage(input: {
  search: string;
  status: CustomFieldStatus;
  page: number;
  pageSize: CustomFieldPageSize;
  signal?: AbortSignal;
}) {
  const request = createClient().rpc('get_custom_field_administration_page', {
    target_search: input.search.trim().slice(0, 100),
    target_status: input.status,
    target_page: input.page,
    target_page_size: input.pageSize,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return pageSchema.parse(data);
}

export async function createCustomField(input: {
  module: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('create_custom_field_definition', {
    target_module: input.module,
    target_field_key: input.fieldKey,
    target_label: input.label,
    target_field_type: input.fieldType,
    target_options: input.options,
    target_required: input.required,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

export async function setCustomFieldActive(input: {
  id: string;
  active: boolean;
  version: number;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('set_custom_field_active', {
    target_definition_id: input.id,
    target_active: input.active,
    expected_version: input.version,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return mutationResultSchema.parse(data);
}

/**
 * Ready-made packs of customer fields. The keys, labels and types are fixed
 * server-side so the same field cannot end up as `dob` TEXT in one organization
 * and `birthday` DATE in another, which is what makes a birthday greeting
 * impossible to build later.
 */
export const customerFieldTemplates = [
  {
    key: 'CUSTOMER_PERSONAL',
    name: 'Personal details',
    summary: 'Date of birth, anniversary, spouse, occupation, language, best time to call',
    fieldCount: 6,
  },
  {
    key: 'CUSTOMER_FAMILY',
    name: 'Family & usage',
    summary: 'Family size, children, vehicles in household, primary use',
    fieldCount: 4,
  },
  {
    key: 'CUSTOMER_FINANCE',
    name: 'Finance',
    summary: 'Income band, preferred bank, existing loan, GST number',
    fieldCount: 4,
  },
] as const;

export type CustomerFieldTemplateKey = (typeof customerFieldTemplates)[number]['key'];

const templateResultSchema = z.object({
  template: z.string(),
  created: z.array(z.string()),
  skipped: z.array(z.string()),
  replayed: z.boolean(),
});

export async function applyCustomerFieldTemplate(input: {
  templateKey: CustomerFieldTemplateKey;
  requestId: string;
}) {
  const { data, error } = await createClient().rpc('apply_customer_field_template', {
    target_template_key: input.templateKey,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return templateResultSchema.parse(data);
}
