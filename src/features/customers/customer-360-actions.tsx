'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, PhoneCall, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ProviderCallStartError, startProviderCall } from '@/features/calls/call-workspace-api';
import { liveCallQueryKeyRoot } from '@/features/calls/live-call-api';
import {
  fetchCustomerTelecmiCallOptions,
  fetchCustomer360EditData,
  updateCustomer360,
  uploadCustomerDocument,
  type Customer360EditData,
  type UpdateCustomer360Input,
} from './customer-workspace-api';

type ContactDraft = UpdateCustomer360Input['payload']['contacts'][number];
type AddressDraft = UpdateCustomer360Input['payload']['addresses'][number];
type VehicleDraft = UpdateCustomer360Input['payload']['vehicles'][number];

type CustomerEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  onSaved: () => void;
};

function inputValue(value: unknown) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function customFieldValue(field: Customer360EditData['custom_fields'][number], value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (field.field_type === 'NUMBER') {
    const numberValue = Number(trimmed);
    return Number.isFinite(numberValue) ? numberValue : trimmed;
  }
  if (field.field_type === 'BOOLEAN') return trimmed.toLowerCase() === 'true';
  if (field.field_type === 'MULTI_SELECT')
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return trimmed;
}

function initialContacts(data: Customer360EditData): ContactDraft[] {
  return data.contacts.map((contact) => ({
    id: contact.id,
    type: contact.type === 'EMAIL' ? 'EMAIL' : 'PHONE',
    value: contact.value,
    is_primary: contact.is_primary,
  }));
}

function initialAddresses(data: Customer360EditData): AddressDraft[] {
  return data.addresses.map((address) => ({
    id: address.id,
    address_type: address.address_type,
    address: Object.fromEntries(
      Object.entries(address.address).flatMap(([key, value]) =>
        typeof value === 'string' || typeof value === 'number' ? [[key, String(value)]] : [],
      ),
    ),
  }));
}

function initialVehicles(data: Customer360EditData): VehicleDraft[] {
  return data.vehicles.map((vehicle) => ({
    id: vehicle.id,
    registration: vehicle.registration,
    brand: vehicle.brand,
    model: vehicle.model,
    variant: vehicle.variant,
    model_year: vehicle.model_year,
  }));
}

function initialCustomValues(data: Customer360EditData) {
  return Object.fromEntries(
    data.custom_fields.map((field) => [field.definition_id, inputValue(field.value)]),
  );
}

function CustomerEditFormDialog({
  open,
  onOpenChange,
  data,
  onSaved,
}: CustomerEditDialogProps & { data: Customer360EditData }) {
  const [fullName, setFullName] = useState(data.customer.full_name);
  const [primaryPhone, setPrimaryPhone] = useState(data.customer.primary_phone ?? '');
  const [primaryEmail, setPrimaryEmail] = useState(data.customer.primary_email ?? '');
  const [contacts, setContacts] = useState<ContactDraft[]>(() => initialContacts(data));
  const [addresses, setAddresses] = useState<AddressDraft[]>(() => initialAddresses(data));
  const [vehicles, setVehicles] = useState<VehicleDraft[]>(() => initialVehicles(data));
  const [additionalFields, setAdditionalFields] = useState(data.additional_fields);
  const duplicateLabels =
    new Set(additionalFields.map((field) => field.label.trim().toLowerCase())).size !==
    additionalFields.length;
  const [customValues, setCustomValues] = useState<Record<string, string>>(() =>
    initialCustomValues(data),
  );

  const save = useMutation({
    mutationFn: () =>
      updateCustomer360({
        customerId: data.customer.id,
        expectedUpdatedAt: data.customer.updated_at,
        requestId: crypto.randomUUID(),
        payload: {
          full_name: fullName,
          primary_phone: primaryPhone.trim() || null,
          primary_email: primaryEmail.trim() || null,
          contacts: contacts.filter((contact) => contact.value.trim()),
          addresses: addresses.filter((address) =>
            Object.values(address.address).some((value) => value.trim()),
          ),
          vehicles: vehicles.filter((vehicle) =>
            [vehicle.registration, vehicle.brand, vehicle.model, vehicle.variant].some((value) =>
              Boolean(value?.trim()),
            ),
          ),
          custom_fields: data.custom_fields.map((field) => ({
            definition_id: field.definition_id,
            value: customFieldValue(field, customValues[field.definition_id] ?? ''),
          })),
          additional_fields: additionalFields.map((field) => ({
            label: field.label.trim(),
            value: field.value.trim(),
          })),
        },
      }),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
  });

  const updateContact = (index: number, patch: Partial<ContactDraft>) =>
    setContacts((current) =>
      current.map((contact, contactIndex) =>
        contactIndex === index ? { ...contact, ...patch } : contact,
      ),
    );
  const updateAddress = (index: number, key: string, value: string) =>
    setAddresses((current) =>
      current.map((address, addressIndex) =>
        addressIndex === index
          ? { ...address, address: { ...address.address, [key]: value } }
          : address,
      ),
    );
  const updateVehicle = (index: number, patch: Partial<VehicleDraft>) =>
    setVehicles((current) =>
      current.map((vehicle, vehicleIndex) =>
        vehicleIndex === index ? { ...vehicle, ...patch } : vehicle,
      ),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>
            Update the customer record, identifiers, addresses, vehicles, and custom information.
            Existing records are retained for history; add another row whenever needed.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <section className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Label htmlFor="customer-full-name">Customer name</Label>
              <Input
                id="customer-full-name"
                className="mt-2"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                maxLength={180}
                required
              />
            </div>
            <div>
              <Label htmlFor="customer-primary-phone">Primary phone</Label>
              <Input
                id="customer-primary-phone"
                className="mt-2"
                value={primaryPhone}
                onChange={(event) => setPrimaryPhone(event.target.value)}
                inputMode="tel"
                maxLength={30}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="customer-primary-email">Primary email</Label>
              <Input
                id="customer-primary-email"
                className="mt-2"
                value={primaryEmail}
                onChange={(event) => setPrimaryEmail(event.target.value)}
                type="email"
                maxLength={254}
              />
            </div>
          </section>

          <Separator />
          <EditSection
            title="Contact identifiers"
            action="Add contact"
            onAdd={() =>
              setContacts((current) => [
                ...current,
                { type: 'PHONE', value: '', is_primary: false },
              ])
            }
          >
            {contacts.length ? (
              contacts.map((contact, index) => (
                <div
                  key={contact.id ?? `contact-${index}`}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[140px_1fr_120px]"
                >
                  <Select
                    value={contact.type}
                    onValueChange={(type: 'PHONE' | 'EMAIL') => updateContact(index, { type })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PHONE">Phone</SelectItem>
                      <SelectItem value="EMAIL">Email</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={contact.value}
                    onChange={(event) => updateContact(index, { value: event.target.value })}
                    inputMode={contact.type === 'PHONE' ? 'tel' : 'email'}
                    placeholder={contact.type === 'PHONE' ? 'Phone number' : 'Email address'}
                  />
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={contact.is_primary}
                      onChange={(event) =>
                        updateContact(index, { is_primary: event.target.checked })
                      }
                    />
                    Primary
                  </label>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No additional contact identifiers.</p>
            )}
          </EditSection>

          <Separator />
          <EditSection
            title="Addresses"
            action="Add address"
            onAdd={() =>
              setAddresses((current) => [
                ...current,
                {
                  address_type: 'HOME',
                  address: { line1: '', city: '', state: '', postal_code: '', country: '' },
                },
              ])
            }
          >
            {addresses.length ? (
              addresses.map((address, index) => (
                <div
                  key={address.id ?? `address-${index}`}
                  className="space-y-3 rounded-lg border p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Input
                      value={address.address_type}
                      onChange={(event) =>
                        setAddresses((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, address_type: event.target.value }
                              : item,
                          ),
                        )
                      }
                      placeholder="Address type"
                    />
                    <Input
                      value={address.address.line1 ?? ''}
                      onChange={(event) => updateAddress(index, 'line1', event.target.value)}
                      placeholder="Address line 1"
                      className="sm:col-span-2"
                    />
                    <Input
                      value={address.address.line2 ?? ''}
                      onChange={(event) => updateAddress(index, 'line2', event.target.value)}
                      placeholder="Address line 2"
                    />
                    <Input
                      value={address.address.city ?? ''}
                      onChange={(event) => updateAddress(index, 'city', event.target.value)}
                      placeholder="City"
                    />
                    <Input
                      value={address.address.state ?? ''}
                      onChange={(event) => updateAddress(index, 'state', event.target.value)}
                      placeholder="State"
                    />
                    <Input
                      value={address.address.postal_code ?? ''}
                      onChange={(event) => updateAddress(index, 'postal_code', event.target.value)}
                      placeholder="Postal code"
                    />
                    <Input
                      value={address.address.country ?? ''}
                      onChange={(event) => updateAddress(index, 'country', event.target.value)}
                      placeholder="Country"
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No addresses recorded.</p>
            )}
          </EditSection>

          <Separator />
          <EditSection
            title="Vehicles"
            action="Add vehicle"
            onAdd={() =>
              setVehicles((current) => [
                ...current,
                { registration: null, brand: null, model: null, variant: null, model_year: null },
              ])
            }
          >
            {vehicles.length ? (
              vehicles.map((vehicle, index) => (
                <div
                  key={vehicle.id ?? `vehicle-${index}`}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3"
                >
                  <Input
                    value={vehicle.registration ?? ''}
                    onChange={(event) =>
                      updateVehicle(index, { registration: event.target.value || null })
                    }
                    placeholder="Registration"
                  />
                  <Input
                    value={vehicle.brand ?? ''}
                    onChange={(event) =>
                      updateVehicle(index, { brand: event.target.value || null })
                    }
                    placeholder="Brand"
                  />
                  <Input
                    value={vehicle.model ?? ''}
                    onChange={(event) =>
                      updateVehicle(index, { model: event.target.value || null })
                    }
                    placeholder="Model"
                  />
                  <Input
                    value={vehicle.variant ?? ''}
                    onChange={(event) =>
                      updateVehicle(index, { variant: event.target.value || null })
                    }
                    placeholder="Variant"
                  />
                  <Input
                    value={vehicle.model_year ?? ''}
                    onChange={(event) =>
                      updateVehicle(index, {
                        model_year: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                    placeholder="Model year"
                    inputMode="numeric"
                  />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No vehicles recorded.</p>
            )}
          </EditSection>

          {data.custom_fields.length ? (
            <>
              <Separator />
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Custom information</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {data.custom_fields.map((field) => (
                    <div key={field.definition_id}>
                      <Label htmlFor={`customer-custom-${field.definition_id}`}>
                        {field.label}
                      </Label>
                      {(field.field_type === 'SELECT' && field.options.length > 0) ||
                      field.field_type === 'BOOLEAN' ? (
                        <Select
                          value={customValues[field.definition_id] || '__empty'}
                          required={field.required}
                          onValueChange={(value) =>
                            setCustomValues((current) => ({
                              ...current,
                              [field.definition_id]: value === '__empty' ? '' : value,
                            }))
                          }
                        >
                          <SelectTrigger
                            id={`customer-custom-${field.definition_id}`}
                            className="mt-2"
                          >
                            <SelectValue placeholder="Select value" />
                          </SelectTrigger>
                          <SelectContent>
                            {!field.required && (
                              <SelectItem value="__empty">Not specified</SelectItem>
                            )}
                            {(field.field_type === 'BOOLEAN' ? ['true', 'false'] : field.options)
                              .filter(Boolean)
                              .map((option) => (
                                <SelectItem key={option} value={option}>
                                  {field.field_type === 'BOOLEAN'
                                    ? option === 'true'
                                      ? 'Yes'
                                      : 'No'
                                    : option}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id={`customer-custom-${field.definition_id}`}
                          className="mt-2"
                          type={
                            field.field_type === 'DATE'
                              ? 'date'
                              : field.field_type === 'NUMBER'
                                ? 'number'
                                : 'text'
                          }
                          step={field.field_type === 'NUMBER' ? 'any' : undefined}
                          required={field.required}
                          value={customValues[field.definition_id] ?? ''}
                          onChange={(event) =>
                            setCustomValues((current) => ({
                              ...current,
                              [field.definition_id]: event.target.value,
                            }))
                          }
                          placeholder={
                            field.field_type === 'MULTI_SELECT'
                              ? 'Separate values with commas'
                              : field.field_type
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}
          <Separator />
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Additional customer fields</h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={additionalFields.length >= 25}
                onClick={() =>
                  setAdditionalFields((fields) => [...fields, { label: '', value: '' }])
                }
              >
                <Plus className="size-3.5" /> Add field and value
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              These details belong only to this customer.
            </p>
            {additionalFields.map((field, index) => (
              <div
                key={index}
                className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]"
              >
                <div>
                  <Label htmlFor={`additional-label-${index}`}>Field name</Label>
                  <Input
                    id={`additional-label-${index}`}
                    className="mt-2"
                    required
                    maxLength={80}
                    value={field.label}
                    placeholder="For example, Preferred contact time"
                    onChange={(event) =>
                      setAdditionalFields((fields) =>
                        fields.map((item, i) =>
                          i === index ? { ...item, label: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <Label htmlFor={`additional-value-${index}`}>Value</Label>
                  <Input
                    id={`additional-value-${index}`}
                    className="mt-2"
                    required
                    maxLength={2000}
                    value={field.value}
                    placeholder="For example, After 6 pm"
                    onChange={(event) =>
                      setAdditionalFields((fields) =>
                        fields.map((item, i) =>
                          i === index ? { ...item, value: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  type="button"
                  className="self-end"
                  variant="outline"
                  onClick={() =>
                    setAdditionalFields((fields) => fields.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {duplicateLabels && (
              <p role="alert" className="text-sm text-destructive">
                Use a different name for each field.
              </p>
            )}
          </section>
          {save.isError ? (
            <p className="text-sm text-destructive">
              The customer could not be updated. Refresh and try again if someone else changed this
              record.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                duplicateLabels ||
                additionalFields.some((field) => !field.label.trim() || !field.value.trim())
              }
            >
              {save.isPending ? 'Saving…' : 'Save customer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerEditDialog({
  open,
  onOpenChange,
  customerId,
  onSaved,
}: CustomerEditDialogProps) {
  const detailsQuery = useQuery({
    queryKey: ['customer-360-edit-data', customerId],
    queryFn: ({ signal }) => fetchCustomer360EditData(customerId, signal),
    enabled: open,
    staleTime: 0,
  });

  if (detailsQuery.isPending)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>Loading the complete editable customer profile…</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  if (detailsQuery.isError || !detailsQuery.data)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>
              The editable customer details could not be loaded. Confirm customer-update access and
              try again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="button" onClick={() => void detailsQuery.refetch()}>
              Try again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <CustomerEditFormDialog
      key={detailsQuery.data.customer.updated_at}
      open={open}
      onOpenChange={onOpenChange}
      customerId={customerId}
      data={detailsQuery.data}
      onSaved={onSaved}
    />
  );
}

function EditSection({
  title,
  action,
  onAdd,
  children,
}: {
  title: string;
  action: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-3.5" /> {action}
        </Button>
      </div>
      {children}
    </section>
  );
}

export function CustomerTelecmiCallDialog({
  open,
  onOpenChange,
  customerId,
  organizationId,
  customerName,
  customerPhone,
  leadId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  organizationId: string;
  customerName: string;
  customerPhone: string | null;
  leadId?: string;
  onStarted: () => void;
}) {
  const queryClient = useQueryClient();
  const optionsQuery = useQuery({
    queryKey: ['customer-telecmi-call-options', organizationId, customerId, leadId],
    queryFn: ({ signal }) => fetchCustomerTelecmiCallOptions(customerId, signal, leadId),
    enabled: open,
    staleTime: 60_000,
  });
  const [connectionId, setConnectionId] = useState('');
  const requestId = useRef<string | null>(null);
  const options = optionsQuery.data;
  const selectedConnectionId = useMemo(
    () => connectionId || options?.connections[0]?.id || '',
    [connectionId, options?.connections],
  );
  const start = useMutation({
    // Placing a call is not saving a form, and the generic mutation toast said
    // "Your changes have been applied" -- which told a telecaller nothing about
    // what their phone is now doing. This one names the next thing to expect.
    meta: { toast: false },
    mutationFn: () => {
      if (!options?.lead_id || !selectedConnectionId) throw new Error('TELECMI_CALL_NOT_AVAILABLE');
      requestId.current ??= crypto.randomUUID();
      return startProviderCall({
        organizationId,
        connectionId: selectedConnectionId,
        leadId: options.lead_id,
        requestId: requestId.current,
      });
    },
    onSuccess: () => {
      requestId.current = null;
      onOpenChange(false);
      // No toast: LiveCallBar takes over from here and follows the call through
      // ringing, connection and outcome instead of announcing it once. Show it
      // now rather than waiting for the insert broadcast to make the round trip.
      void queryClient.invalidateQueries({ queryKey: liveCallQueryKeyRoot });
      onStarted();
    },
  });

  const unavailable = !customerPhone || !options?.lead_id || !options.connections.length;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestId.current = null;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneCall className="size-5 text-primary" /> Call through CRM
          </DialogTitle>
          <DialogDescription>
            The dealership line rings you first, then securely connects {customerName}. Recording
            follows your dealership’s configured policy.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{customerPhone ?? 'No customer phone recorded'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {options?.branch_name
                ? `The current lead branch is ${options.branch_name}.`
                : 'A visible lead branch is required.'}
            </p>
          </div>
          {optionsQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Checking dealership calling…</p>
          ) : null}
          {optionsQuery.isError ? (
            <p className="text-sm text-destructive">
              Calling options could not be loaded for this customer.
            </p>
          ) : null}
          {options && options.connections.length > 1 ? (
            <div>
              <Label>Dealership line</Label>
              <Select
                value={selectedConnectionId}
                onValueChange={(value) => {
                  setConnectionId(value);
                  requestId.current = null;
                }}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.display_name}
                      {connection.caller_id_label ? ` · ${connection.caller_id_label}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!optionsQuery.isPending && unavailable ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              Dealership calling is not configured for this lead’s branch. Ask a Client Admin to
              enable it for this branch.
            </p>
          ) : null}
          {start.isError ? (
            <p className="text-sm text-destructive">
              {start.error instanceof ProviderCallStartError
                ? start.error.message
                : 'The call could not be started. Check the dealership line and try again.'}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={start.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => start.mutate()}
            disabled={optionsQuery.isPending || unavailable || start.isPending}
          >
            <PhoneCall className="size-4" />
            {/* The dialog title already says "Call through CRM"; repeating it on
                the button says nothing about what pressing it does. */}
            {start.isPending ? 'Starting…' : `Call ${customerName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerDocumentUploadDialog({
  open,
  onOpenChange,
  organizationId,
  customerId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  customerId: string;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('CUSTOMER_DOCUMENT_REQUIRED');
      return uploadCustomerDocument({ organizationId, customerId, file });
    },
    onSuccess: () => {
      setFile(null);
      onOpenChange(false);
      onUploaded();
    },
  });
  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      setFile(null);
      upload.reset();
    }
    onOpenChange(nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="size-5 text-blue-600" /> Upload customer document
          </DialogTitle>
          <DialogDescription>
            The file is stored privately against this customer and remains available only to users
            with the correct customer and document scope.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <Label htmlFor="customer-document-file">Document</Label>
          <Input
            id="customer-document-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              upload.reset();
              setFile(event.target.files?.[0] ?? null);
            }}
          />
          <p className="text-xs text-muted-foreground">
            PDF, Office, image, or text files are supported. File limits are enforced by the secure
            upload service.
          </p>
          {upload.isError ? (
            <p className="text-sm text-destructive">
              The document could not be uploaded. Confirm the file type, size, and document-upload
              permission, then try again.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={upload.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => upload.mutate()}
            disabled={!file || upload.isPending}
          >
            <FileUp className="size-4" /> {upload.isPending ? 'Uploading…' : 'Upload document'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
