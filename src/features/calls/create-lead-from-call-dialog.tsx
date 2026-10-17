'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
import { toast } from '@/components/ui/toast';
import { leadDetailHref } from '@/lib/navigation/record-links';
import { createLeadFromCall, type CallRecord } from './call-workspace-api';

/** An inbound IVR call from a number with no lead or customer yet. */
export function isUnknownInboundCaller(call: CallRecord) {
  return call.direction === 'INBOUND' && !call.lead_id && !call.customer_id && Boolean(call.phone);
}

/** TeleCMI sends 91XXXXXXXXXX; show and dial it as +91 XXXXX XXXXX. */
export function formatCallerPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91'))
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return digits ? `+${digits}` : phone;
}

export function callerTelHref(phone: string) {
  return `tel:+${phone.replace(/\D/g, '')}`;
}

function createLeadMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('CALL_ALREADY_HAS_LEAD'))
    return 'This call is already linked to a lead. Refresh the list to open it.';
  if (message.includes('INVALID_CUSTOMER_NAME')) return 'Enter the customer’s name.';
  if (message.includes('PERMISSION_DENIED') || message.includes('CALL_ACCESS_DENIED'))
    return 'You do not have permission to create a lead from this call.';
  if (message.includes('SCOPE_DENIED')) return 'This call belongs to a branch outside your scope.';
  return 'The lead could not be created. Try again.';
}

export function CreateLeadFromCallDialog({
  call,
  role,
  onOpenChange,
  onCreated,
}: {
  call: CallRecord | null;
  role: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [customerName, setCustomerName] = useState('');
  const [interestedModel, setInterestedModel] = useState('');
  const mutation = useMutation({
    mutationFn: createLeadFromCall,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: 'Lead created',
        description: 'The call is linked to the new lead.',
      });
      setCustomerName('');
      setInterestedModel('');
      onCreated();
      onOpenChange(false);
      // The caller's number may already belong to a customer: the lead opens
      // on the possible-match review, where the user links or creates one
      // (never merged automatically, AGENTS.md rule 11).
      router.push(`${leadDetailHref(role, result.lead_id)}?match=customer`);
    },
  });
  const close = (open: boolean) => {
    if (!open) {
      setCustomerName('');
      setInterestedModel('');
      mutation.reset();
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={call !== null} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create lead from call</DialogTitle>
          <DialogDescription>
            {call?.phone ? formatCallerPhone(call.phone) : 'Unknown number'} called the dealership
            number. The new lead is yours and this call is added to its history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!call || !customerName.trim()) return;
            mutation.mutate({ callId: call.id, customerName, interestedModel });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="lead-from-call-name">Customer name</Label>
            <Input
              id="lead-from-call-name"
              value={customerName}
              maxLength={200}
              autoFocus
              required
              onChange={(event) => setCustomerName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lead-from-call-model">Interested model (optional)</Label>
            <Input
              id="lead-from-call-model"
              value={interestedModel}
              maxLength={200}
              onChange={(event) => setInterestedModel(event.target.value)}
            />
          </div>
          {mutation.isError && (
            <p className="text-sm text-destructive">{createLeadMessage(mutation.error)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!customerName.trim() || mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
