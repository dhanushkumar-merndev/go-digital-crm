'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, Pencil, UserRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { OptionalSelect } from '@/components/shared/optional-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isVersionConflictCode } from '@/lib/supabase/version-conflict';
import {
  companyAddress,
  companyFundingLabels,
  companyFundingModes,
  companyFundingSummary,
  companyLeaseLabels,
  companyLeaseTypes,
  emptyLeadCompany,
  fetchLeadCompanySuggestion,
  leadCompanyOptions,
  normalizeTaxId,
  setLeadBuyerType,
  validateLeadCompany,
  type CompanyFundingMode,
  type CompanyLeaseType,
  type LeadBuyerType,
  type LeadCompany,
  type LeadCompanyInput,
} from './lead-buyer-type';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-semibold">{value || '—'}</div>
    </div>
  );
}

/**
 * Who this enquiry is registered to, and the action that moves it between an
 * individual and a company. Shared by Customer 360 and Lead detail.
 */
export function LeadBuyerCard({
  leadId,
  buyerType,
  company,
  canEdit,
  onSaved,
}: {
  leadId: string;
  buyerType: LeadBuyerType;
  company: LeadCompany | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [dialog, setDialog] = useState<'company' | 'individual' | null>(null);
  const isCompany = buyerType === 'COMPANY';
  const close = () => setDialog(null);
  const saved = () => {
    setDialog(null);
    onSaved();
  };
  return (
    <>
      <Card className="shadow-none">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {isCompany ? (
              <Building2 className="size-4 text-blue-600" />
            ) : (
              <UserRound className="size-4 text-blue-600" />
            )}
            Registered buyer
            <Badge variant={isCompany ? 'default' : 'secondary'}>
              {isCompany ? 'Company' : 'Individual'}
            </Badge>
          </CardTitle>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {isCompany ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => setDialog('individual')}>
                    Change to individual
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDialog('company')}>
                    <Pencil className="size-3.5" /> Edit company
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setDialog('company')}>
                  <Building2 className="size-3.5" /> Register as company
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isCompany && company ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Company name" value={company.company_name} />
              <Field label="Company type" value={company.company_type} />
              <Field label="Industry" value={company.industry} />
              <Field label="GSTIN" value={company.gstin} />
              <Field label="PAN" value={company.pan} />
              <Field
                label="Contact person"
                value={
                  [company.contact_person, company.contact_designation]
                    .filter(Boolean)
                    .join(' · ') || null
                }
              />
              <Field label="Company phone" value={company.company_phone} />
              <Field label="Company email" value={company.company_email} />
              <Field label="Vehicle funding" value={companyFundingSummary(company)} />
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label="Company address" value={companyAddress(company)} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This enquiry is registered to an individual.
              {canEdit &&
                ' Register it as a company to record the company, its GST details and how the vehicle is funded. Each vehicle a company needs is its own lead.'}
            </p>
          )}
        </CardContent>
      </Card>
      {canEdit && dialog === 'company' && (
        <LeadCompanyDialog
          leadId={leadId}
          company={company}
          registering={!isCompany}
          onClose={close}
          onSaved={saved}
        />
      )}
      {canEdit && dialog === 'individual' && (
        <ChangeToIndividualDialog
          leadId={leadId}
          company={company}
          onClose={close}
          onSaved={saved}
        />
      )}
    </>
  );
}

function toInput(company: LeadCompany | null): LeadCompanyInput {
  if (!company) return { ...emptyLeadCompany };
  // Pick the editable keys so version and updated_at never travel in the payload.
  return Object.fromEntries(
    Object.keys(emptyLeadCompany).map((key) => [key, company[key as keyof LeadCompanyInput]]),
  ) as LeadCompanyInput;
}

function saveErrorMessage(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (isVersionConflictCode(code))
    return 'Someone else updated this company. Close and reopen to see the latest, then try again.';
  if (code === '42501') return 'You do not have permission to change this lead.';
  if (message === 'LEAD_COMPANY_GSTIN_INVALID') return 'The GSTIN is not valid.';
  if (message === 'LEAD_COMPANY_PAN_INVALID') return 'The PAN is not valid.';
  return 'The company could not be saved. Check the values and try again.';
}

function LeadCompanyDialog({
  leadId,
  company,
  registering,
  onClose,
  onSaved,
}: {
  leadId: string;
  company: LeadCompany | null;
  /** True when the lead is currently an individual and this registers it. */
  registering: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<LeadCompanyInput>(() => toInput(company));
  const [tenure, setTenure] = useState(
    company?.lease_tenure_months == null ? '' : String(company.lease_tenure_months),
  );
  const [submitted, setSubmitted] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const set = <K extends keyof LeadCompanyInput>(key: K, value: LeadCompanyInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const text = (key: keyof LeadCompanyInput) => (draft[key] as string | null) ?? '';
  const textField = (key: keyof LeadCompanyInput) => ({
    id: `lead-company-${key}`,
    value: text(key),
    onChange: (event: { target: { value: string } }) =>
      set(key, (event.target.value || null) as never),
  });

  // Only a lead that has never had a company asks for one from a sibling lead.
  const suggestion = useQuery({
    queryKey: ['lead-company-suggestion', leadId],
    queryFn: ({ signal }) => fetchLeadCompanySuggestion(leadId, signal),
    enabled: !company,
    staleTime: 60_000,
    retry: false,
  });

  const suggested = suggestion.data?.company ?? null;

  const tenureMonths = tenure.trim() ? Number(tenure.trim()) : null;
  const payload: LeadCompanyInput = {
    ...draft,
    company_name: draft.company_name.trim(),
    gstin: normalizeTaxId(draft.gstin),
    pan: normalizeTaxId(draft.pan),
    // Lease details exist only on a leased vehicle.
    lease_type: draft.funding_mode === 'LEASE' ? draft.lease_type : null,
    lessor_name: draft.funding_mode === 'LEASE' ? draft.lessor_name : null,
    lease_tenure_months: draft.funding_mode === 'LEASE' ? tenureMonths : null,
  };
  const errors = validateLeadCompany(payload);
  const invalid = Object.keys(errors).length > 0;
  const shown = submitted ? errors : {};

  const save = useMutation({
    mutationFn: () =>
      setLeadBuyerType({
        leadId,
        buyerType: 'COMPANY',
        expectedVersion: company?.version ?? null,
        requestId,
        company: payload,
      }),
    onSuccess: onSaved,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{registering ? 'Register as company' : 'Edit company'}</DialogTitle>
          <DialogDescription>
            Saved on this lead. One lead tracks one vehicle, so a company buying several vehicles
            has one lead for each.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (!invalid) save.mutate();
          }}
        >
          {suggested && (
            <Alert>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  <span className="font-semibold">{suggested.company_name}</span> is on another
                  enquiry of this customer.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft((current) => ({ ...current, ...suggested }))}
                >
                  Use these details
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Company</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="lead-company-company_name">Company name</Label>
                <Input
                  {...textField('company_name')}
                  onChange={(event) => set('company_name', event.target.value)}
                  maxLength={160}
                  required
                  aria-invalid={Boolean(shown.company_name)}
                  placeholder="Registered name of the company"
                />
                {shown.company_name && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {shown.company_name}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="lead-company-company_type">Company type</Label>
                <OptionalSelect
                  id="lead-company-company_type"
                  value={draft.company_type}
                  options={leadCompanyOptions.company_type}
                  placeholder="Company type"
                  onChange={(value) => set('company_type', value)}
                />
              </div>
              <div>
                <Label htmlFor="lead-company-industry">Industry</Label>
                <Input
                  {...textField('industry')}
                  maxLength={80}
                  placeholder="e.g. Logistics, IT services"
                />
              </div>
              <div>
                <Label htmlFor="lead-company-gstin">GSTIN</Label>
                <Input
                  {...textField('gstin')}
                  maxLength={15}
                  className="uppercase"
                  aria-invalid={Boolean(shown.gstin)}
                  placeholder="29ABCDE1234F1Z5"
                />
                {shown.gstin && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {shown.gstin}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="lead-company-pan">Company PAN</Label>
                <Input
                  {...textField('pan')}
                  maxLength={10}
                  className="uppercase"
                  aria-invalid={Boolean(shown.pan)}
                  placeholder="ABCDE1234F"
                />
                {shown.pan && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {shown.pan}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Contact at the company</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="lead-company-contact_person">Contact person</Label>
                <Input {...textField('contact_person')} maxLength={120} />
              </div>
              <div>
                <Label htmlFor="lead-company-contact_designation">Designation</Label>
                <Input
                  {...textField('contact_designation')}
                  maxLength={80}
                  placeholder="e.g. Director, Admin manager"
                />
              </div>
              <div>
                <Label htmlFor="lead-company-company_phone">Company phone</Label>
                <Input {...textField('company_phone')} type="tel" maxLength={20} />
              </div>
              <div>
                <Label htmlFor="lead-company-company_email">Company email</Label>
                <Input {...textField('company_email')} type="email" maxLength={160} />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Registered address</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <Label htmlFor="lead-company-address_line">Address</Label>
                <Input {...textField('address_line')} maxLength={240} />
              </div>
              <div>
                <Label htmlFor="lead-company-city">City</Label>
                <Input {...textField('city')} maxLength={80} />
              </div>
              <div>
                <Label htmlFor="lead-company-state">State</Label>
                <Input {...textField('state')} maxLength={80} />
              </div>
              <div>
                <Label htmlFor="lead-company-postal_code">PIN code</Label>
                <Input {...textField('postal_code')} inputMode="numeric" maxLength={10} />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Vehicle funding</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="lead-company-funding_mode">How is this vehicle funded?</Label>
                <OptionalSelect
                  id="lead-company-funding_mode"
                  value={draft.funding_mode}
                  options={companyFundingModes}
                  placeholder="Funding"
                  labelFor={(value) => companyFundingLabels[value as CompanyFundingMode] ?? value}
                  onChange={(value) => set('funding_mode', value as CompanyFundingMode | null)}
                />
              </div>
              {draft.funding_mode === 'LEASE' && (
                <>
                  <div>
                    <Label htmlFor="lead-company-lease_type">Lease type</Label>
                    <OptionalSelect
                      id="lead-company-lease_type"
                      value={draft.lease_type}
                      options={companyLeaseTypes}
                      placeholder="Lease type"
                      labelFor={(value) => companyLeaseLabels[value as CompanyLeaseType] ?? value}
                      onChange={(value) => set('lease_type', value as CompanyLeaseType | null)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="lead-company-lessor_name">Leasing company</Label>
                    <Input
                      {...textField('lessor_name')}
                      maxLength={120}
                      placeholder="Who the vehicle is leased through"
                    />
                  </div>
                  <div>
                    <Label htmlFor="lead-company-lease_tenure_months">Lease tenure (months)</Label>
                    <Input
                      id="lead-company-lease_tenure_months"
                      value={tenure}
                      onChange={(event) => setTenure(event.target.value.replace(/\D/g, ''))}
                      inputMode="numeric"
                      maxLength={3}
                      list="lead-company-lease-tenures"
                      aria-invalid={Boolean(shown.lease_tenure_months)}
                      placeholder="e.g. 36"
                    />
                    <datalist id="lead-company-lease-tenures">
                      {leadCompanyOptions.lease_tenure_months.map((months) => (
                        <option key={months} value={months} />
                      ))}
                    </datalist>
                    {shown.lease_tenure_months && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {shown.lease_tenure_months}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>

          {save.isError && (
            <Alert variant="destructive">
              <AlertDescription>{saveErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : registering ? 'Register as company' : 'Save company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangeToIndividualDialog({
  leadId,
  company,
  onClose,
  onSaved,
}: {
  leadId: string;
  company: LeadCompany | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: () =>
      setLeadBuyerType({
        leadId,
        buyerType: 'INDIVIDUAL',
        expectedVersion: company?.version ?? null,
        requestId,
        company: null,
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Change to individual?</DialogTitle>
          <DialogDescription>
            This enquiry will be listed as an individual lead again.
            {company &&
              ` The details of ${company.company_name} are kept and come back if you register it as a company again.`}
          </DialogDescription>
        </DialogHeader>
        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {isVersionConflictCode((save.error as { code?: unknown } | null)?.code)
                ? 'Someone else updated this company. Close and reopen to see the latest, then try again.'
                : 'The lead could not be changed. Try again.'}
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Changing…' : 'Change to individual'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
