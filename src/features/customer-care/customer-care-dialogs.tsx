'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  fetchCustomerCareCustomerOptions,
  type CustomerCareCustomerOption,
  type CustomerCareRecord,
} from './customer-care-api';
import {
  customerCareLabel,
  customerCareNextStatuses,
  customerCareTypes,
  type CustomerCareType,
} from './customer-care-query';

const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function CreateCustomerCareDialog({
  open,
  initialType,
  pending,
  error,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  initialType: CustomerCareType;
  pending: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    option: CustomerCareCustomerOption;
    caseType: CustomerCareType;
    priority: (typeof priorities)[number];
    subject: string;
    description: string;
    requestId: string;
  }) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [caseType, setCaseType] = useState<CustomerCareType>(initialType);
  const [priority, setPriority] = useState<(typeof priorities)[number]>('NORMAL');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const debouncedSearch = useDebouncedValue(search, 300);
  const options = useQuery({
    queryKey: ['customer-care-customer-options', debouncedSearch],
    queryFn: ({ signal }) => fetchCustomerCareCustomerOptions(debouncedSearch, signal),
    enabled: open,
  });
  const selected = options.data?.find((option) => option.booking_id === bookingId);
  const reset = () => {
    setSearch('');
    setBookingId('');
    setCaseType(initialType);
    setPriority('NORMAL');
    setSubject('');
    setDescription('');
    setRequestId(crypto.randomUUID());
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create customer-care case</DialogTitle>
          <DialogDescription>
            Link the case to the existing Customer 360 and latest accessible booking.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <Field label="Find customer or booking">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Customer, phone or booking number"
              maxLength={160}
            />
          </Field>
          <Field label="Customer and booking">
            <Select value={bookingId} onValueChange={setBookingId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an accessible booking" />
              </SelectTrigger>
              <SelectContent>
                {(options.data ?? []).map((option) => (
                  <SelectItem key={option.booking_id} value={option.booking_id}>
                    {option.customer_name} · {option.booking_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {selected && (
            <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              {selected.phone || 'No phone'} · {selected.vehicle || 'No linked vehicle'}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Case type">
              <Select
                value={caseType}
                onValueChange={(value) => setCaseType(value as CustomerCareType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {customerCareTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {customerCareLabel(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as typeof priority)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorities.map((value) => (
                    <SelectItem key={value} value={value}>
                      {customerCareLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Subject">
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={180}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
              rows={5}
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={
              pending || !selected || subject.trim().length < 3 || description.trim().length < 5
            }
            onClick={() =>
              selected &&
              void onCreate({
                option: selected,
                caseType,
                priority,
                subject,
                description,
                requestId,
              })
            }
          >
            {pending ? 'Creating…' : 'Create case'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerCareCaseSheet({
  record,
  role,
  canManage,
  canEscalate,
  pending,
  error,
  onClose,
  onUpdate,
}: {
  record: CustomerCareRecord | null;
  role: string;
  canManage: boolean;
  canEscalate: boolean;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onUpdate: (input: {
    status: string;
    priority: (typeof priorities)[number];
    resolution?: string;
    feedbackRating?: number;
    feedbackComments?: string;
    escalationReason?: string;
    escalationSeverity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    reason: string;
    requestId: string;
  }) => Promise<void>;
}) {
  const [status, setStatus] = useState(record?.status ?? '');
  const [priority, setPriority] = useState<(typeof priorities)[number]>(
    record?.priority ?? 'NORMAL',
  );
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState(record?.resolution ?? '');
  const [rating, setRating] = useState('');
  const [feedbackComments, setFeedbackComments] = useState('');
  const [escalationReason, setEscalationReason] = useState('');
  const [escalationSeverity, setEscalationSeverity] = useState<
    'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  >('HIGH');
  const availableStatuses = record
    ? [record.status, ...customerCareNextStatuses(record.status)]
    : [];
  return (
    <Sheet open={Boolean(record)} onOpenChange={(open) => !open && !pending && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {record && (
          <>
            <SheetHeader>
              <SheetTitle>{record.case_number}</SheetTitle>
              <SheetDescription>
                {customerCareLabel(record.case_type)} · version {record.version}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 py-5">
              <div className="rounded-lg border p-4">
                <p className="font-semibold">{record.customer_name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {record.booking_number || 'No booking'} · {record.vehicle || 'No vehicle'}
                </p>
                <p className="mt-3 text-sm font-medium">{record.subject}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {record.description}
                </p>
                <Button className="mt-3" variant="outline" size="sm" asChild>
                  <a href={`/${role}/customers/${record.customer_id}`}>Open Customer 360</a>
                </Button>
              </div>
              {canManage && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Status">
                      <Select value={status} onValueChange={setStatus}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableStatuses.map((value) => (
                            <SelectItem key={value} value={value}>
                              {customerCareLabel(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select
                        value={priority}
                        onValueChange={(value) => setPriority(value as typeof priority)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {priorities.map((value) => (
                            <SelectItem key={value} value={value}>
                              {customerCareLabel(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field label="Change reason">
                    <Textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={1000}
                      rows={2}
                    />
                  </Field>
                  <Field label="Resolution">
                    <Textarea
                      value={resolution}
                      onChange={(event) => setResolution(event.target.value)}
                      maxLength={4000}
                      rows={3}
                    />
                  </Field>
                  {record.case_type === 'FEEDBACK' && (
                    <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
                      <Field label="Rating">
                        <Select value={rating} onValueChange={setRating}>
                          <SelectTrigger>
                            <SelectValue placeholder="1–5" />
                          </SelectTrigger>
                          <SelectContent>
                            {['1', '2', '3', '4', '5'].map((value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Feedback comments">
                        <Textarea
                          value={feedbackComments}
                          onChange={(event) => setFeedbackComments(event.target.value)}
                          maxLength={4000}
                          rows={2}
                        />
                      </Field>
                    </div>
                  )}
                  {canEscalate && (
                    <div className="rounded-lg border p-4">
                      <p className="mb-3 text-sm font-semibold">Escalation (optional)</p>
                      <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
                        <Input
                          value={escalationReason}
                          onChange={(event) => setEscalationReason(event.target.value)}
                          placeholder="Escalation reason"
                          maxLength={1000}
                        />
                        <Select
                          value={escalationSeverity}
                          onValueChange={(value) =>
                            setEscalationSeverity(value as typeof escalationSeverity)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((value) => (
                              <SelectItem key={value} value={value}>
                                {customerCareLabel(value)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
            <SheetFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Close
              </Button>
              {canManage && (
                <Button
                  disabled={
                    pending ||
                    (status !== record.status && reason.trim().length < 3) ||
                    (['RESOLVED', 'CLOSED'].includes(status) && resolution.trim().length < 5)
                  }
                  onClick={() =>
                    void onUpdate({
                      status,
                      priority,
                      resolution: resolution.trim() || undefined,
                      feedbackRating: rating ? Number(rating) : undefined,
                      feedbackComments: feedbackComments.trim() || undefined,
                      escalationReason: escalationReason.trim() || undefined,
                      escalationSeverity: escalationReason.trim() ? escalationSeverity : undefined,
                      reason,
                      requestId: crypto.randomUUID(),
                    })
                  }
                >
                  {pending ? 'Saving…' : 'Save changes'}
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
