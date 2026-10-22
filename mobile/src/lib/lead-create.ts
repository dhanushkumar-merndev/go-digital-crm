import { supabase } from './supabase';

// AGENTS.md 9.2 canonical sources, in the order the web Add lead form lists them.
export const leadSources = [
  'Manual',
  'Facebook',
  'Instagram',
  'Google Ads',
  'Website',
  'WhatsApp Business',
  'CarWale',
  'CarDekho',
  'Justdial',
  'IndiaMART',
  'Other',
] as const;

export type LeadSource = (typeof leadSources)[number];

export type LeadCreateBranch = { id: string; name: string; organization_id: string };

/** Branches the user may create a lead in; RLS limits the rows to their scope. */
export async function fetchLeadCreateBranches() {
  const { data, error } = await supabase
    .from('branches')
    .select('id,name,organization_id')
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return (data ?? []) as LeadCreateBranch[];
}

export type MobileLeadCreateInput = {
  branch: LeadCreateBranch;
  source: LeadSource;
  customerName: string;
  phone: string;
  interestedModel: string;
};

// The same `create_lead` the web form calls. The team is left to the server,
// which resolves it from the creator's sales-team membership, as the web form
// does for every own-records user.
export async function createMobileLead(input: MobileLeadCreateInput) {
  const { data, error } = await supabase.rpc('create_lead', {
    target_organization_id: input.branch.organization_id,
    target_branch_id: input.branch.id,
    target_team_id: null,
    lead_source: input.source,
    lead_customer_name: input.customerName.trim(),
    lead_phone: input.phone.trim(),
    lead_email: null,
    lead_source_detail: null,
    lead_campaign: null,
    lead_interested_model: input.interestedModel.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export function leadCreateErrorMessage(error: unknown) {
  const code =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (/PHONE/i.test(code)) return 'Enter a valid mobile number.';
  if (/NAME/i.test(code)) return 'Enter the customer name (at least 2 letters).';
  if (/PERMISSION|FORBIDDEN|42501/i.test(code)) return 'You cannot add leads in this branch.';
  return 'The lead could not be added. Check your connection and try again.';
}
