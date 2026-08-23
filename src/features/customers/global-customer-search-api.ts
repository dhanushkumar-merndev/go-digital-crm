import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const customerSearchRecordSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  primary_phone: z.string().nullable(),
  primary_email: z.string().nullable(),
  updated_at: z.string(),
});

const customerSearchResultSchema = z.object({
  records: z.array(customerSearchRecordSchema),
  has_next: z.boolean(),
});

export type GlobalCustomerSearchRecord = z.infer<typeof customerSearchRecordSchema>;
export type GlobalCustomerSearchResult = z.infer<typeof customerSearchResultSchema>;

export const globalCustomerSearchKey = ['global-customer-search'] as const;

export async function searchAuthorizedCustomers(input: {
  search: string;
  page: number;
  pageSize?: 25 | 50 | 100;
  signal?: AbortSignal;
}): Promise<GlobalCustomerSearchResult> {
  const request = createClient().rpc('search_authorized_customers', {
    target_search: input.search.normalize('NFKC').trim().slice(0, 160),
    target_page: Math.max(1, Math.floor(input.page)),
    target_page_size: input.pageSize ?? 25,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
  return customerSearchResultSchema.parse(data);
}
