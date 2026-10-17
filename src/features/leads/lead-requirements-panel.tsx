'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { CarFront, IndianRupee, Pencil, Repeat2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { OptionalBooleanSelect, OptionalSelect } from '@/components/shared/optional-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { isVersionConflictCode } from '@/lib/supabase/version-conflict';
import { fetchCustomer360EditData } from '@/features/customers/customer-workspace-api';
import { InterestedModelPicker } from './interested-model-picker';
import {
  emptyLeadRequirements,
  formatBudgetRange,
  formatRupees,
  leadRequirementOptions,
  updateLeadRequirements,
  yesNo,
  type LeadRequirements,
  type LeadRequirementsInput,
} from './lead-requirements';

export type ExchangeVehicleSummary = {
  id: string;
  registration: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  model_year: number | null;
  fuel_type: string | null;
  odometer_km: number | null;
  ownership: string | null;
  purchase_year: number | null;
};

export type ExchangeCaseSummary = {
  status: string;
  customer_expected_value: number | null;
  estimated_value: number | null;
  accepted_value: number | null;
};

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-semibold">{value || '—'}</div>
    </div>
  );
}

function SectionCard({
  title,
  icon,
  canEdit,
  onEdit,
  children,
}: {
  title: string;
  icon: ReactNode;
  canEdit: boolean;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
        </CardTitle>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      </CardContent>
    </Card>
  );
}

function vehicleName(vehicle: ExchangeVehicleSummary | null) {
  if (!vehicle) return null;
  return [vehicle.brand, vehicle.model, vehicle.variant].filter(Boolean).join(' ') || null;
}

/**
 * Vehicle requirement, budget & preference and existing vehicle & exchange for
 * one enquiry. Shared by Customer 360 and Lead detail so both read the same.
 */
export function LeadRequirementsCards({
  leadId,
  customerId,
  branchId = null,
  interestedModel,
  requirements,
  exchangeVehicle,
  exchangeCase,
  canEdit,
  onSaved,
}: {
  leadId: string;
  customerId: string | null;
  /** Narrows the model search to the lead's branch stock; null searches the catalogue. */
  branchId?: string | null;
  interestedModel: string | null;
  requirements: LeadRequirements | null;
  exchangeVehicle: ExchangeVehicleSummary | null;
  exchangeCase: ExchangeCaseSummary | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const r = requirements;
  return (
    <>
      <SectionCard
        title="Vehicle requirement"
        icon={<CarFront className="size-4 text-blue-600" />}
        canEdit={canEdit}
        onEdit={() => setEditing(true)}
      >
        <Field label="Interested model" value={interestedModel} />
        <Field label="Variant" value={r?.variant} />
        <Field label="Fuel type" value={r?.fuel_type} />
        <Field label="Transmission" value={r?.transmission} />
        <Field label="Colour preference" value={r?.colour_preference} />
        <Field label="Delivery timeline" value={r?.delivery_timeline} />
        <Field label="Purchase timeline" value={r?.purchase_timeline} />
        <Field label="Usage" value={r?.usage} />
        <Field label="Test drive required" value={yesNo(r?.test_drive_required)} />
      </SectionCard>
      <SectionCard
        title="Budget & preference"
        icon={<IndianRupee className="size-4 text-emerald-600" />}
        canEdit={canEdit}
        onEdit={() => setEditing(true)}
      >
        <Field
          label="Budget range"
          value={formatBudgetRange(r?.budget_min ?? null, r?.budget_max ?? null)}
        />
        <Field label="Preferred brand" value={r?.preferred_brand} />
        <Field label="Purchase type" value={r?.purchase_type} />
        <Field
          label="Financing"
          value={
            r?.finance_required == null
              ? null
              : r.finance_required
                ? (r.finance_note ?? 'Loan required')
                : 'Self funded'
          }
        />
        <Field label="Insurance preference" value={r?.insurance_preference} />
        <Field label="RTO preference" value={r?.rto_preference} />
        <Field
          label="Preferred dealer services"
          value={r?.preferred_services.length ? r.preferred_services.join(', ') : null}
        />
        <Field
          label="Competitors considered"
          value={r?.competitors.length ? r.competitors.join(', ') : null}
        />
      </SectionCard>
      <SectionCard
        title="Existing vehicle & exchange"
        icon={<Repeat2 className="size-4 text-violet-600" />}
        canEdit={canEdit}
        onEdit={() => setEditing(true)}
      >
        <Field label="Current vehicle" value={vehicleName(exchangeVehicle)} />
        <Field label="Registration" value={exchangeVehicle?.registration} />
        <Field
          label="Year of purchase"
          value={exchangeVehicle?.purchase_year ?? exchangeVehicle?.model_year}
        />
        <Field
          label="KMs driven"
          value={
            exchangeVehicle?.odometer_km != null
              ? `${exchangeVehicle.odometer_km.toLocaleString('en-IN')} km`
              : null
          }
        />
        <Field label="Fuel type" value={exchangeVehicle?.fuel_type} />
        <Field label="Ownership" value={exchangeVehicle?.ownership} />
        <Field label="Exchange expected" value={yesNo(r?.exchange_required)} />
        <Field
          label="Expected exchange value"
          value={formatRupees(r?.expected_exchange_value ?? exchangeCase?.customer_expected_value)}
        />
        <Field
          label="Exchange status"
          value={
            exchangeCase ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{exchangeCase.status.replaceAll('_', ' ')}</Badge>
                {formatRupees(exchangeCase.accepted_value ?? exchangeCase.estimated_value)}
              </span>
            ) : null
          }
        />
      </SectionCard>
      {canEdit && editing && (
        <LeadRequirementsSheet
          leadId={leadId}
          customerId={customerId}
          branchId={branchId}
          interestedModel={interestedModel}
          requirements={requirements}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
    </>
  );
}

function toInput(requirements: LeadRequirements | null): LeadRequirementsInput {
  if (!requirements) return { ...emptyLeadRequirements };
  // Pick the editable keys so version and updated_at never travel in the payload.
  return Object.fromEntries(
    Object.keys(emptyLeadRequirements).map((key) => [
      key,
      requirements[key as keyof LeadRequirementsInput],
    ]),
  ) as LeadRequirementsInput;
}

/** Money is entered in lakh because that is how a car budget is discussed. */
function lakhText(value: number | null) {
  return value == null ? '' : String(Number((value / 100000).toFixed(2)));
}
function fromLakh(text: string) {
  const parsed = Number(text.trim());
  return text.trim() && Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100000) : null;
}

function LeadRequirementsSheet({
  leadId,
  customerId,
  branchId,
  interestedModel,
  requirements,
  onClose,
  onSaved,
}: {
  leadId: string;
  customerId: string | null;
  branchId: string | null;
  interestedModel: string | null;
  requirements: LeadRequirements | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<LeadRequirementsInput>(() => toInput(requirements));
  const [model, setModel] = useState(interestedModel ?? '');
  const [budgetMin, setBudgetMin] = useState(lakhText(requirements?.budget_min ?? null));
  const [budgetMax, setBudgetMax] = useState(lakhText(requirements?.budget_max ?? null));
  const [exchangeValue, setExchangeValue] = useState(
    lakhText(requirements?.expected_exchange_value ?? null),
  );
  const [competitors, setCompetitors] = useState((requirements?.competitors ?? []).join(', '));
  const [requestId] = useState(() => crypto.randomUUID());
  const set = <K extends keyof LeadRequirementsInput>(key: K, value: LeadRequirementsInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const text = (key: keyof LeadRequirementsInput) => (draft[key] as string | null) ?? '';

  // Owned vehicles come from the edit model; without customer.update the picker
  // simply is not offered and the stored choice is kept.
  const vehicles = useQuery({
    queryKey: ['customer-360-edit', customerId, 'vehicles-for-exchange'],
    queryFn: ({ signal }) => fetchCustomer360EditData(customerId as string, signal),
    enabled: Boolean(customerId),
    staleTime: 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      updateLeadRequirements({
        leadId,
        expectedVersion: requirements?.version ?? null,
        requestId,
        payload: {
          ...draft,
          interested_model: model.trim() || null,
          budget_min: fromLakh(budgetMin),
          budget_max: fromLakh(budgetMax),
          expected_exchange_value: fromLakh(exchangeValue),
          competitors: competitors
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: onSaved,
  });
  const conflict =
    save.isError && isVersionConflictCode((save.error as { code?: unknown } | null)?.code);
  const budgetInvalid =
    fromLakh(budgetMin) != null &&
    fromLakh(budgetMax) != null &&
    (fromLakh(budgetMax) as number) < (fromLakh(budgetMin) as number);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto p-6 sm:w-[640px]">
        <SheetTitle>Edit requirements</SheetTitle>
        <SheetDescription className="mt-1">
          What this enquiry is looking for. Saved on the lead, so a later enquiry from the same
          customer keeps its own requirements.
        </SheetDescription>
        <form
          className="mt-6 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!budgetInvalid) save.mutate();
          }}
        >
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Vehicle requirement</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label>Interested model</Label>
                <div className="mt-2">
                  <InterestedModelPicker
                    value={model}
                    onValueChange={setModel}
                    branchId={branchId}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-variant">Variant</Label>
                <Input
                  id="req-variant"
                  className="mt-2"
                  maxLength={120}
                  value={text('variant')}
                  onChange={(event) => set('variant', event.target.value || null)}
                />
              </div>
              <div>
                <Label htmlFor="req-colour">Colour preference</Label>
                <Input
                  id="req-colour"
                  className="mt-2"
                  maxLength={120}
                  value={text('colour_preference')}
                  onChange={(event) => set('colour_preference', event.target.value || null)}
                />
              </div>
              <div>
                <Label htmlFor="req-fuel">Fuel type</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-fuel"
                    value={draft.fuel_type}
                    options={leadRequirementOptions.fuel_type}
                    placeholder="Fuel type"
                    onChange={(value) => set('fuel_type', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-transmission">Transmission</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-transmission"
                    value={draft.transmission}
                    options={leadRequirementOptions.transmission}
                    placeholder="Transmission"
                    onChange={(value) => set('transmission', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-delivery">Delivery timeline</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-delivery"
                    value={draft.delivery_timeline}
                    options={leadRequirementOptions.timeline}
                    placeholder="Delivery timeline"
                    onChange={(value) => set('delivery_timeline', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-purchase">Purchase timeline</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-purchase"
                    value={draft.purchase_timeline}
                    options={leadRequirementOptions.timeline}
                    placeholder="Purchase timeline"
                    onChange={(value) => set('purchase_timeline', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-usage">Usage</Label>
                <Input
                  id="req-usage"
                  className="mt-2"
                  maxLength={120}
                  placeholder="Family use, daily commute…"
                  value={text('usage')}
                  onChange={(event) => set('usage', event.target.value || null)}
                />
              </div>
              <div>
                <Label htmlFor="req-test-drive">Test drive required</Label>
                <div className="mt-2">
                  <OptionalBooleanSelect
                    id="req-test-drive"
                    value={draft.test_drive_required}
                    placeholder="Test drive"
                    onChange={(value) => set('test_drive_required', value)}
                  />
                </div>
              </div>
            </div>
          </section>

          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Budget & preference</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="req-budget-min">Budget from (₹ lakh)</Label>
                <Input
                  id="req-budget-min"
                  className="mt-2"
                  inputMode="decimal"
                  value={budgetMin}
                  onChange={(event) => setBudgetMin(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="req-budget-max">Budget up to (₹ lakh)</Label>
                <Input
                  id="req-budget-max"
                  className="mt-2"
                  inputMode="decimal"
                  value={budgetMax}
                  onChange={(event) => setBudgetMax(event.target.value)}
                  aria-invalid={budgetInvalid}
                />
              </div>
              <div>
                <Label htmlFor="req-brand">Preferred brand</Label>
                <Input
                  id="req-brand"
                  className="mt-2"
                  maxLength={80}
                  value={text('preferred_brand')}
                  onChange={(event) => set('preferred_brand', event.target.value || null)}
                />
              </div>
              <div>
                <Label htmlFor="req-purchase-type">Purchase type</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-purchase-type"
                    value={draft.purchase_type}
                    options={leadRequirementOptions.purchase_type}
                    placeholder="Purchase type"
                    onChange={(value) => set('purchase_type', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-finance">Finance required</Label>
                <div className="mt-2">
                  <OptionalBooleanSelect
                    id="req-finance"
                    value={draft.finance_required}
                    placeholder="Finance"
                    onChange={(value) => set('finance_required', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-finance-note">Finance note</Label>
                <Input
                  id="req-finance-note"
                  className="mt-2"
                  maxLength={240}
                  placeholder="Loan for 80%, 5 years"
                  value={text('finance_note')}
                  onChange={(event) => set('finance_note', event.target.value || null)}
                />
              </div>
              <div>
                <Label htmlFor="req-insurance">Insurance preference</Label>
                <div className="mt-2">
                  <OptionalSelect
                    id="req-insurance"
                    value={draft.insurance_preference}
                    options={leadRequirementOptions.insurance_preference}
                    placeholder="Insurance"
                    onChange={(value) => set('insurance_preference', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-rto">RTO preference</Label>
                <Input
                  id="req-rto"
                  className="mt-2"
                  maxLength={120}
                  value={text('rto_preference')}
                  onChange={(event) => set('rto_preference', event.target.value || null)}
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="req-competitors">Competitors considered (comma separated)</Label>
                <Textarea
                  id="req-competitors"
                  className="mt-2"
                  rows={2}
                  value={competitors}
                  onChange={(event) => setCompetitors(event.target.value)}
                />
              </div>
              <fieldset className="sm:col-span-2">
                <legend className="text-sm font-medium">Preferred dealer services</legend>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  {leadRequirementOptions.services.map((service) => (
                    <label key={service} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.preferred_services.includes(service)}
                        onChange={(event) =>
                          set(
                            'preferred_services',
                            event.target.checked
                              ? [...draft.preferred_services, service]
                              : draft.preferred_services.filter((item) => item !== service),
                          )
                        }
                      />
                      {service}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </section>

          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Exchange</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="req-exchange">Exchange expected</Label>
                <div className="mt-2">
                  <OptionalBooleanSelect
                    id="req-exchange"
                    value={draft.exchange_required}
                    placeholder="Exchange"
                    onChange={(value) => set('exchange_required', value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="req-exchange-value">Expected exchange value (₹ lakh)</Label>
                <Input
                  id="req-exchange-value"
                  className="mt-2"
                  inputMode="decimal"
                  value={exchangeValue}
                  onChange={(event) => setExchangeValue(event.target.value)}
                />
              </div>
              {vehicles.data && (
                <div className="sm:col-span-2">
                  <Label htmlFor="req-exchange-vehicle">Vehicle to exchange</Label>
                  <div className="mt-2">
                    <OptionalSelect
                      id="req-exchange-vehicle"
                      value={draft.exchange_vehicle_id}
                      options={vehicles.data.vehicles.map((vehicle) => vehicle.id)}
                      placeholder="Owned vehicle"
                      onChange={(value) => set('exchange_vehicle_id', value)}
                      labelFor={(id) => {
                        const vehicle = vehicles.data.vehicles.find((item) => item.id === id);
                        return vehicle
                          ? [vehicle.brand, vehicle.model, vehicle.registration]
                              .filter(Boolean)
                              .join(' · ') || 'Unnamed vehicle'
                          : id;
                      }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add or correct owned vehicles from Edit customer.
                  </p>
                </div>
              )}
            </div>
          </section>

          {budgetInvalid && (
            <p role="alert" className="text-sm text-destructive">
              The upper budget must be at least the lower budget.
            </p>
          )}
          {save.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {conflict
                  ? 'Someone else updated these requirements. Close and reopen to see the latest, then try again.'
                  : 'Requirements could not be saved. Check the values and try again.'}
              </AlertDescription>
            </Alert>
          )}
          <SheetFooter className="flex-row justify-end gap-2 p-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || budgetInvalid}>
              {save.isPending ? 'Saving…' : 'Save requirements'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
