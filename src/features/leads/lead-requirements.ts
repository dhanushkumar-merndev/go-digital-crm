import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable().default(null);
const nullableNumber = z.coerce.number().nullable().default(null);
const nullableBoolean = z.boolean().nullable().default(null);

/** One enquiry's vehicle requirement, budget and exchange preferences. */
export const leadRequirementsSchema = z.object({
  variant: nullableString,
  fuel_type: nullableString,
  transmission: nullableString,
  colour_preference: nullableString,
  usage: nullableString,
  delivery_timeline: nullableString,
  purchase_timeline: nullableString,
  budget_min: nullableNumber,
  budget_max: nullableNumber,
  preferred_brand: nullableString,
  purchase_type: nullableString,
  finance_required: nullableBoolean,
  finance_note: nullableString,
  exchange_required: nullableBoolean,
  exchange_vehicle_id: z.uuid().nullable().default(null),
  expected_exchange_value: nullableNumber,
  insurance_preference: nullableString,
  rto_preference: nullableString,
  preferred_services: z.array(z.string()).default([]),
  test_drive_required: nullableBoolean,
  competitors: z.array(z.string()).default([]),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
});

export type LeadRequirements = z.infer<typeof leadRequirementsSchema>;

export type LeadRequirementsInput = Omit<LeadRequirements, 'version' | 'updated_at'>;

export const emptyLeadRequirements: LeadRequirementsInput = {
  variant: null,
  fuel_type: null,
  transmission: null,
  colour_preference: null,
  usage: null,
  delivery_timeline: null,
  purchase_timeline: null,
  budget_min: null,
  budget_max: null,
  preferred_brand: null,
  purchase_type: null,
  finance_required: null,
  finance_note: null,
  exchange_required: null,
  exchange_vehicle_id: null,
  expected_exchange_value: null,
  insurance_preference: null,
  rto_preference: null,
  preferred_services: [],
  test_drive_required: null,
  competitors: [],
};

/** Choices offered in the editor; the column stays free text for dealership-specific values. */
export const leadRequirementOptions = {
  fuel_type: ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'],
  transmission: ['Manual', 'Automatic', 'AMT', 'CVT', 'DCA / DCT'],
  timeline: [
    'Immediate',
    'Within 1 week',
    'Within 1 month',
    '1–3 months',
    '3–6 months',
    'Undecided',
  ],
  purchase_type: ['Personal', 'Corporate', 'Fleet', 'Government'],
  insurance_preference: [
    'Comprehensive',
    'Comprehensive with zero depreciation',
    'Third party',
    'Own arrangement',
  ],
  services: [
    'Home delivery',
    'Extended warranty',
    'Service package',
    'Accessories fitment',
    'Doorstep test drive',
  ],
  ownership: ['First owner', 'Second owner', 'Third owner or more'],
} as const;

const updateResultSchema = z.object({
  lead_id: z.uuid(),
  version: z.coerce.number().int().positive(),
  replayed: z.boolean(),
});

export async function updateLeadRequirements(input: {
  leadId: string;
  expectedVersion: number | null;
  requestId: string;
  /** interested_model is stored on the lead; omit it to leave the model unchanged. */
  payload: LeadRequirementsInput & { interested_model?: string | null };
}) {
  const { data, error } = await createClient().rpc('update_lead_requirements', {
    target_lead_id: input.leadId,
    expected_version: input.expectedVersion,
    target_payload: input.payload,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return updateResultSchema.parse(data);
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** "₹18 – ₹20 lakh" style range; lakh is how a dealership reads a car budget. */
export function formatBudgetRange(min: number | null, max: number | null) {
  const lakh = (value: number) =>
    value >= 100000
      ? `₹${(value / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
      : inrFormatter.format(value);
  if (min == null && max == null) return null;
  if (min != null && max != null)
    return `${lakh(min)} – ${lakh(max)}${max >= 100000 ? ' lakh' : ''}`;
  const only = (min ?? max) as number;
  return `${min != null ? 'From' : 'Up to'} ${lakh(only)}${only >= 100000 ? ' lakh' : ''}`;
}

export function formatRupees(value: number | null | undefined) {
  return value == null ? null : inrFormatter.format(value);
}

export function yesNo(value: boolean | null | undefined) {
  return value == null ? null : value ? 'Yes' : 'No';
}
