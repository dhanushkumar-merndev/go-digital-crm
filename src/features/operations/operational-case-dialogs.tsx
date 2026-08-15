'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Download, FileUp, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type {
  DeliveryChecklistItem,
  OperationalCaseBookingOption,
  OperationalCaseDetail,
} from './operational-case-api';
import {
  operationalCaseNextStatuses,
  operationalCaseStatusLabel,
  type OperationalCaseDepartment,
} from './operational-case-query';

type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

function localInputValue(value: unknown, kind: 'datetime' | 'date') {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return kind === 'date' ? value.slice(0, 10) : '';
  const offset = date.getTimezoneOffset() * 60_000;
  const local = new Date(date.getTime() - offset).toISOString();
  return kind === 'date' ? local.slice(0, 10) : local.slice(0, 16);
}

function isoOrUndefined(value: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function CreateOperationalCaseDialog({
  open,
  onOpenChange,
  department,
  options,
  search,
  onSearchChange,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: OperationalCaseDepartment;
  options: OperationalCaseBookingOption[];
  search: string;
  onSearchChange: (value: string) => void;
  busy: boolean;
  error?: string;
  onSubmit: (input: {
    bookingId: string;
    priority: Priority;
    dueAt?: string;
    notes?: string;
    requestId: string;
  }) => Promise<void>;
}) {
  const [bookingId, setBookingId] = useState('');
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const requestId = useRef(crypto.randomUUID());

  function changed() {
    requestId.current = crypto.randomUUID();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bookingId) return;
    await onSubmit({
      bookingId,
      priority,
      dueAt: isoOrUndefined(dueAt),
      notes: notes.trim() || undefined,
      requestId: requestId.current,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create {operationalCaseStatusLabel(department)} case</DialogTitle>
          <DialogDescription>
            Select an eligible booking. Tenant, customer and branch links are derived by the server.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} onChange={changed}>
          <div className="space-y-2">
            <Label htmlFor="case-booking-search">Find booking</Label>
            <Input
              id="case-booking-search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Booking number, customer or phone"
            />
            <Select value={bookingId} onValueChange={(value) => setBookingId(value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select booking" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.booking_id} value={option.booking_id}>
                    {option.booking_number} · {option.customer_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {operationalCaseStatusLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-due-at">Due at</Label>
              <Input
                id="case-due-at"
                type="datetime-local"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="case-notes">Initial notes</Label>
            <Textarea
              id="case-notes"
              value={notes}
              maxLength={4000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !bookingId}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Create case
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DepartmentFields({
  department,
  details,
}: {
  department: OperationalCaseDepartment;
  details: Record<string, unknown>;
}) {
  if (department === 'FINANCE')
    return (
      <>
        <Field name="lender" label="Lender" defaultValue={details.lender} />
        <Field
          name="application_reference"
          label="Application reference"
          defaultValue={details.application_reference}
        />
        <Field
          name="approved_amount"
          label="Approved amount"
          type="number"
          defaultValue={details.approved_amount}
        />
        <Field
          name="disbursed_at"
          label="Disbursed at"
          type="datetime-local"
          defaultValue={localInputValue(details.disbursed_at, 'datetime')}
        />
      </>
    );
  if (department === 'INSURANCE')
    return (
      <>
        <Field name="insurer" label="Insurer" defaultValue={details.insurer} />
        <Field name="policy_number" label="Policy number" defaultValue={details.policy_number} />
        <Field
          name="policy_start"
          label="Policy start"
          type="date"
          defaultValue={localInputValue(details.policy_start, 'date')}
        />
        <Field
          name="policy_end"
          label="Policy end"
          type="date"
          defaultValue={localInputValue(details.policy_end, 'date')}
        />
      </>
    );
  if (department === 'RTO')
    return (
      <>
        <Field
          name="registration_number"
          label="Registration number"
          defaultValue={details.registration_number}
        />
        <Field
          name="submitted_at"
          label="Submitted at"
          type="datetime-local"
          defaultValue={localInputValue(details.submitted_at, 'datetime')}
        />
        <Field
          name="completed_at"
          label="Completed at"
          type="datetime-local"
          defaultValue={localInputValue(details.completed_at, 'datetime')}
        />
      </>
    );
  if (department === 'EXCHANGE')
    return (
      <>
        <Field
          name="estimated_value"
          label="Estimated value"
          type="number"
          defaultValue={details.estimated_value}
        />
        <Field
          name="accepted_value"
          label="Accepted value"
          type="number"
          defaultValue={details.accepted_value}
        />
        <Field
          name="quoted_value"
          label="Evaluation quote"
          type="number"
          defaultValue={undefined}
        />
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="inspection_notes">Inspection notes</Label>
          <Textarea id="inspection_notes" name="inspection_notes" maxLength={4000} />
        </div>
      </>
    );
  return (
    <>
      <Field
        name="scheduled_at"
        label="Scheduled at"
        type="datetime-local"
        defaultValue={localInputValue(details.scheduled_at, 'datetime')}
      />
      <Field
        name="delivered_at"
        label="Delivered at"
        type="datetime-local"
        defaultValue={localInputValue(details.delivered_at, 'datetime')}
      />
    </>
  );
}

function Field({
  name,
  label,
  type = 'text',
  defaultValue,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue: unknown;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`case-${name}`}>{label}</Label>
      <Input
        id={`case-${name}`}
        name={name}
        type={type}
        defaultValue={
          typeof defaultValue === 'string' || typeof defaultValue === 'number' ? defaultValue : ''
        }
      />
    </div>
  );
}

function patchFromForm(department: OperationalCaseDepartment, form: FormData) {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  const optionalNumber = (name: string) => {
    const value = text(name);
    return value ? Number(value) : null;
  };
  const optionalTime = (name: string) => isoOrUndefined(text(name)) ?? null;
  const common: Record<string, unknown> = {
    priority: text('priority'),
    due_at: optionalTime('due_at'),
    notes: text('notes') || null,
  };
  if (department === 'FINANCE')
    Object.assign(common, {
      lender: text('lender') || null,
      application_reference: text('application_reference') || null,
      approved_amount: optionalNumber('approved_amount'),
      disbursed_at: optionalTime('disbursed_at'),
    });
  if (department === 'INSURANCE')
    Object.assign(common, {
      insurer: text('insurer') || null,
      policy_number: text('policy_number') || null,
      policy_start: text('policy_start') || null,
      policy_end: text('policy_end') || null,
    });
  if (department === 'RTO')
    Object.assign(common, {
      registration_number: text('registration_number') || null,
      submitted_at: optionalTime('submitted_at'),
      completed_at: optionalTime('completed_at'),
    });
  if (department === 'EXCHANGE') {
    Object.assign(common, {
      estimated_value: optionalNumber('estimated_value'),
      accepted_value: optionalNumber('accepted_value'),
    });
    const inspectionNotes = text('inspection_notes');
    const quotedValue = optionalNumber('quoted_value');
    if (inspectionNotes || quotedValue !== null)
      Object.assign(common, { inspection: { notes: inspectionNotes }, quoted_value: quotedValue });
  }
  if (department === 'DELIVERY')
    Object.assign(common, {
      scheduled_at: optionalTime('scheduled_at'),
      delivered_at: optionalTime('delivered_at'),
      signature_file_id: text('signature_file_id') || null,
    });
  return common;
}

export function OperationalCaseDetailSheet({
  open,
  onOpenChange,
  detail,
  canManage,
  canUpload,
  canDownload,
  busy,
  error,
  onUpdate,
  onChecklist,
  onUpload,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail?: OperationalCaseDetail;
  canManage: boolean;
  canUpload: boolean;
  canDownload: boolean;
  busy: boolean;
  error?: string;
  onUpdate: (input: {
    status: string;
    patch: Record<string, unknown>;
    reason: string;
    requestId: string;
  }) => Promise<void>;
  onChecklist: (
    item: DeliveryChecklistItem,
    completed: boolean,
    requestId: string,
  ) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onDownload: (id: string) => Promise<void>;
}) {
  const [nextStatus, setNextStatus] = useState(detail?.status ?? '');
  const requestId = useRef(crypto.randomUUID());
  const choices = detail ? operationalCaseNextStatuses(detail.department, detail.status) : [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const form = new FormData(event.currentTarget);
    await onUpdate({
      status: nextStatus || detail.status,
      patch: patchFromForm(detail.department, form),
      reason: String(form.get('reason') ?? '').trim(),
      requestId: requestId.current,
    });
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto p-6 sm:w-[680px]">
        <SheetTitle>
          {detail ? `${operationalCaseStatusLabel(detail.department)} case` : 'Case details'}
        </SheetTitle>
        <SheetDescription>
          {detail
            ? `${detail.booking_number ?? 'No booking'} · ${detail.customer_name}`
            : 'Loading scoped case data.'}
        </SheetDescription>
        {!detail ? (
          <div className="grid min-h-48 place-items-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap gap-2">
              <Badge>{operationalCaseStatusLabel(detail.status)}</Badge>
              <Badge variant="outline">{operationalCaseStatusLabel(detail.priority)}</Badge>
              <Badge variant="outline">{detail.document_count} documents</Badge>
            </div>

            {detail.department === 'DELIVERY' ? (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Delivery checklist</h3>
                {detail.checklist.map((item) => (
                  <label
                    key={item.id}
                    className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={item.completed}
                      disabled={
                        !canManage ||
                        busy ||
                        !['PLANNING', 'CHECKLIST_PENDING'].includes(detail.status)
                      }
                      onChange={() => onChecklist(item, !item.completed, crypto.randomUUID())}
                    />
                    <span>
                      <span className="font-medium">{item.category}</span>
                      <br />
                      <span className="text-muted-foreground">{item.item}</span>
                    </span>
                  </label>
                ))}
              </section>
            ) : null}

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Private documents</h3>
                {canUpload ? (
                  <Label className="cursor-pointer">
                    <span className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-semibold">
                      <FileUp className="size-4" /> Upload
                    </span>
                    <Input
                      className="hidden"
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,image/webp"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onUpload(file);
                        event.target.value = '';
                      }}
                    />
                  </Label>
                ) : null}
              </div>
              {detail.documents.length ? (
                detail.documents.map((document) => (
                  <div
                    key={document.id}
                    className="flex items-center justify-between rounded-lg border p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{document.file_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {Math.ceil(document.size_bytes / 1024)} KB
                      </p>
                    </div>
                    {canDownload ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onDownload(document.id)}
                        aria-label={`Download ${document.file_name}`}
                      >
                        <Download className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
              )}
            </section>

            {canManage ? (
              <form
                className="space-y-4 border-t pt-5"
                onSubmit={submit}
                onChange={() => {
                  requestId.current = crypto.randomUUID();
                }}
              >
                <h3 className="text-sm font-semibold">Progress case</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Next status</Label>
                    <Select value={nextStatus || detail.status} onValueChange={setNextStatus}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={detail.status}>
                          Keep {operationalCaseStatusLabel(detail.status)}
                        </SelectItem>
                        {choices.map((status) => (
                          <SelectItem key={status} value={status}>
                            {operationalCaseStatusLabel(status)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Priority</Label>
                    <Select name="priority" defaultValue={detail.priority}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((value) => (
                          <SelectItem key={value} value={value}>
                            {operationalCaseStatusLabel(value)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    name="due_at"
                    label="Due at"
                    type="datetime-local"
                    defaultValue={localInputValue(detail.due_at, 'datetime')}
                  />
                  <DepartmentFields department={detail.department} details={detail.details} />
                  {detail.department === 'DELIVERY' ? (
                    <div className="space-y-2">
                      <Label>Signature document</Label>
                      <Select
                        name="signature_file_id"
                        defaultValue={
                          typeof detail.details.signature_file_id === 'string'
                            ? detail.details.signature_file_id
                            : undefined
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select uploaded signature" />
                        </SelectTrigger>
                        <SelectContent>
                          {detail.documents.map((document) => (
                            <SelectItem key={document.id} value={document.id}>
                              {document.file_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="case-detail-notes">Notes</Label>
                    <Textarea
                      id="case-detail-notes"
                      name="notes"
                      maxLength={4000}
                      defaultValue={
                        typeof detail.details.notes === 'string' ? detail.details.notes : ''
                      }
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="case-change-reason">Change reason</Label>
                    <Textarea
                      id="case-change-reason"
                      name="reason"
                      maxLength={1000}
                      placeholder="Required when status changes"
                    />
                  </div>
                </div>
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save changes
                </Button>
              </form>
            ) : error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
