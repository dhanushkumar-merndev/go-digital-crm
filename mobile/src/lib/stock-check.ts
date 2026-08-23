import { supabase } from '@/lib/supabase';

export type MobileStockCheckRecord = {
  key: string;
  branch_name: string;
  brand_name: string;
  model_name: string;
  variant_name: string;
  color: string | null;
  fuel: string | null;
  transmission: string | null;
  available: number;
  reserved: number;
  allocated: number;
  incoming: number;
  availability: 'AVAILABLE' | 'LIMITED' | 'INCOMING' | 'UNAVAILABLE';
};

export type MobileStockCheckPage = {
  records: MobileStockCheckRecord[];
  total: number;
  kpis: {
    available_units: number;
    limited_groups: number;
    incoming_units: number;
    unavailable_groups: number;
  };
};

export async function fetchMobileStockCheck(input: {
  search: string;
  availability: string;
  page: number;
}): Promise<MobileStockCheckPage> {
  const { data, error } = await supabase.rpc('get_stock_check_page_v2', {
    target_search: input.search.trim().slice(0, 100),
    target_page: input.page,
    target_page_size: 25,
    target_availability: input.availability,
    target_branch_id: null,
    target_sort: 'model:asc',
    target_brand: null,
    target_model: null,
    target_variant: null,
    target_fuel: null,
    target_transmission: null,
    target_color: null,
  });
  if (error || !data) throw error ?? new Error('STOCK_CHECK_UNAVAILABLE');
  return data as MobileStockCheckPage;
}
