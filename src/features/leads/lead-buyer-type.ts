import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const nullableString = z.string().nullable().default(null);

/**
 * Who one enquiry is registered to. The type belongs to the lead, not the
 * customer: a lead tracks one vehicle, so a company buying ten cars is ten
 * COMPANY leads, each with its own company profile and funding.
 */
export const leadBuyerTypes = ['INDIVIDUAL', 'COMPANY'] as const;
export const leadBuyerTypeSchema = z
  .enum(leadBuyerTypes)
  .nullable()
  .optional()
  .transform((value) => value ?? 'INDIVIDUAL');
export type LeadBuyerType = (typeof leadBuyerTypes)[number];

export const companyFundingModes = ['OUTRIGHT', 'LOAN', 'LEASE'] as const;
export type CompanyFundingMode = (typeof companyFundingModes)[number];
export const companyFundingLabels: Record<CompanyFundingMode, string> = {
  OUTRIGHT: 'Outright purchase',
  LOAN: 'Corporate loan',
  LEASE: 'Lease',
};

export const companyLeaseTypes = ['OPERATING', 'FINANCE'] as const;
export type CompanyLeaseType = (typeof companyLeaseTypes)[number];
export const companyLeaseLabels: Record<CompanyLeaseType, string> = {
  OPERATING: 'Operating lease',
  FINANCE: 'Finance lease',
};

/** The company a COMPANY lead is registered to, and how the vehicle is funded. */
export const leadCompanySchema = z.object({
  company_name: z.string(),
  company_type: nullableString,
  industry: nullableString,
  gstin: nullableString,
  pan: nullableString,
  contact_person: nullableString,
  contact_designation: nullableString,
  company_phone: nullableString,
  company_email: nullableString,
  address_line: nullableString,
  city: nullableString,
  state: nullableString,
  postal_code: nullableString,
  funding_mode: z.enum(companyFundingModes).nullable().default(null),
  lease_type: z.enum(companyLeaseTypes).nullable().default(null),
  lessor_name: nullableString,
  lease_tenure_months: z.coerce.number().int().nullable().default(null),
  version: z.coerce.number().int().positive(),
  updated_at: z.string(),
});

export type LeadCompany = z.infer<typeof leadCompanySchema>;
export type LeadCompanyInput = Omit<LeadCompany, 'version' | 'updated_at'>;

export const emptyLeadCompany: LeadCompanyInput = {
  company_name: '',
  company_type: null,
  industry: null,
  gstin: null,
  pan: null,
  contact_person: null,
  contact_designation: null,
  company_phone: null,
  company_email: null,
  address_line: null,
  city: null,
  state: null,
  postal_code: null,
  funding_mode: null,
  lease_type: null,
  lessor_name: null,
  lease_tenure_months: null,
};

/** Choices offered in the dialog; the columns stay free text for dealership-specific values. */
export const leadCompanyOptions = {
  company_type: [
    'Proprietorship',
    'Partnership',
    'LLP',
    'Private Limited',
    'Public Limited',
    'Trust / Society',
    'Government / PSU',
  ],
  lease_tenure_months: [24, 36, 48, 60],
} as const;

// Mirrors lead_company_profiles_tax_id_check; the RPC upper-cases before it checks.
const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const panPattern = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function normalizeTaxId(value: string | null) {
  const cleaned = (value ?? '').replace(/\s/g, '').toUpperCase();
  return cleaned || null;
}

/** Field-level problems the RPC would reject, keyed by field, for inline display. */
export function validateLeadCompany(input: LeadCompanyInput) {
  const errors: Partial<Record<keyof LeadCompanyInput, string>> = {};
  const name = input.company_name.trim();
  if (name.length < 2 || name.length > 160) errors.company_name = 'Enter the company name.';
  const gstin = normalizeTaxId(input.gstin);
  if (gstin && !gstinPattern.test(gstin))
    errors.gstin = 'A GSTIN has 15 characters, for example 29ABCDE1234F1Z5.';
  const pan = normalizeTaxId(input.pan);
  if (pan && !panPattern.test(pan)) errors.pan = 'A PAN has 10 characters, for example ABCDE1234F.';
  if (
    input.funding_mode === 'LEASE' &&
    input.lease_tenure_months != null &&
    (!Number.isInteger(input.lease_tenure_months) ||
      input.lease_tenure_months < 1 ||
      input.lease_tenure_months > 120)
  )
    errors.lease_tenure_months = 'Lease tenure is between 1 and 120 months.';
  return errors;
}

const setBuyerTypeResultSchema = z.object({
  lead_id: z.uuid(),
  buyer_type: z.enum(leadBuyerTypes),
  version: z.coerce.number().int().positive().nullable(),
  replayed: z.boolean(),
});

/**
 * Register a lead as a company (creating or updating its company profile) or
 * back as an individual. `expectedVersion` is the company profile's version,
 * null when the lead has never had one.
 */
export async function setLeadBuyerType(input: {
  leadId: string;
  buyerType: LeadBuyerType;
  expectedVersion: number | null;
  requestId: string;
  company: LeadCompanyInput | null;
}) {
  const { data, error } = await createClient().rpc('set_lead_buyer_type', {
    target_lead_id: input.leadId,
    target_buyer_type: input.buyerType,
    expected_version: input.expectedVersion,
    target_company: input.company,
    target_request_id: input.requestId,
  });
  if (error) throw error;
  return setBuyerTypeResultSchema.parse(data);
}

const companySuggestionSchema = leadCompanySchema
  .pick({
    company_name: true,
    company_type: true,
    industry: true,
    gstin: true,
    pan: true,
    contact_person: true,
    contact_designation: true,
    company_phone: true,
    company_email: true,
    address_line: true,
    city: true,
    state: true,
    postal_code: true,
  })
  .extend({ source_lead_id: z.uuid() });

export type LeadCompanySuggestion = {
  sourceLeadId: string;
  company: Omit<z.infer<typeof companySuggestionSchema>, 'source_lead_id'>;
};

/**
 * The company on another lead of the same customer or mobile, so the second
 * vehicle of a fleet order does not need its company retyped. Funding is per
 * vehicle and is never suggested.
 */
export async function fetchLeadCompanySuggestion(
  leadId: string,
  signal?: AbortSignal,
): Promise<LeadCompanySuggestion | null> {
  const request = createClient().rpc('get_lead_company_suggestion', { target_lead_id: leadId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data) return null;
  const { source_lead_id: sourceLeadId, ...company } = companySuggestionSchema.parse(data);
  return { sourceLeadId, company };
}

export function companyFundingSummary(company: LeadCompany | null) {
  if (!company?.funding_mode) return null;
  if (company.funding_mode !== 'LEASE') return companyFundingLabels[company.funding_mode];
  return [
    company.lease_type ? companyLeaseLabels[company.lease_type] : companyFundingLabels.LEASE,
    company.lessor_name ? `through ${company.lessor_name}` : null,
    company.lease_tenure_months ? `${company.lease_tenure_months} months` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function companyAddress(company: LeadCompany | null) {
  if (!company) return null;
  return (
    [company.address_line, company.city, company.state, company.postal_code]
      .filter(Boolean)
      .join(', ') || null
  );
}
