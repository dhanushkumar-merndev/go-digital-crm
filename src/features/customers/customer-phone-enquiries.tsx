'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { customerDetailHref, leadDetailHref } from '@/lib/navigation/record-links';
import { createUuid } from '@/lib/uuid';
import {
  fetchCustomerPhoneEnquiries,
  resolveLeadCustomer,
  type CustomerPhoneEnquiry,
} from './customer-workspace-api';

const LINK_REASON = 'Same phone number; confirmed this is the same customer.';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

/**
 * Leads on this customer's phone numbers that sit under another customer or
 * under none. AGENTS.md rule 11 forbids merging on a phone match, so these are
 * listed, not folded into the Leads table; an unlinked one can be linked here
 * through resolve_lead_customer, which records the reason and the audit row.
 */
export function CustomerPhoneEnquiries({
  role,
  customerId,
  customerName,
  queryScope,
}: {
  role: string;
  customerId: string;
  customerName: string;
  queryScope: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState<CustomerPhoneEnquiry | null>(null);
  const enquiries = useQuery({
    queryKey: ['customer-phone-enquiries', ...queryScope, customerId],
    queryFn: ({ signal }) => fetchCustomerPhoneEnquiries(customerId, signal),
  });

  if (enquiries.isPending) return <Skeleton className="mt-4 h-24 w-full" />;
  if (enquiries.isError)
    return (
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        Other enquiries on this phone could not be loaded.
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => enquiries.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (!enquiries.data.length) return null;

  return (
    <Card className="mt-4 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Other enquiries on this phone</CardTitle>
        <CardDescription>
          Same phone number, but not linked to {customerName}. Link an enquiry if it is the same
          person; leave it if the number is shared.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Lead ID</TableHead>
              <TableHead className="whitespace-nowrap">Name on lead</TableHead>
              <TableHead className="whitespace-nowrap">Model</TableHead>
              <TableHead className="whitespace-nowrap">Lifecycle</TableHead>
              <TableHead className="whitespace-nowrap">Owner</TableHead>
              <TableHead className="whitespace-nowrap">Created</TableHead>
              <TableHead className="whitespace-nowrap">Customer</TableHead>
              <TableHead className="whitespace-nowrap text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enquiries.data.map((enquiry) => (
              <TableRow key={enquiry.lead_id}>
                <TableCell className="whitespace-nowrap">
                  <Link
                    href={leadDetailHref(role, enquiry.lead_id)}
                    className="font-semibold text-primary hover:underline"
                  >
                    {enquiry.lead_id.slice(0, 8).toUpperCase()}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{enquiry.customer_name}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {enquiry.interested_model ?? '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <StatusBadge value={enquiry.lifecycle_status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {enquiry.assigned_user_name ?? 'Unassigned'}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(enquiry.created_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {enquiry.linked_customer_id ? (
                    <Link
                      href={customerDetailHref(role, enquiry.linked_customer_id)}
                      className="hover:text-primary hover:underline"
                    >
                      {enquiry.linked_customer_name ?? 'Another customer'}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not linked</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {enquiry.can_link ? (
                    <Button size="sm" variant="outline" onClick={() => setLinking(enquiry)}>
                      <Link2 className="size-4" /> Link here
                    </Button>
                  ) : enquiry.linked_customer_id ? (
                    <span className="text-xs text-muted-foreground">Separate customer</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">No link access</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {linking ? (
        <LinkEnquiryDialog
          key={linking.lead_id}
          enquiry={linking}
          customerId={customerId}
          customerName={customerName}
          onOpenChange={(open) => !open && setLinking(null)}
          onLinked={() => {
            setLinking(null);
            void queryClient.invalidateQueries({
              queryKey: ['customer-phone-enquiries', ...queryScope, customerId],
            });
            void queryClient.invalidateQueries({
              queryKey: ['customer-360', ...queryScope, customerId],
            });
          }}
        />
      ) : null}
    </Card>
  );
}

function LinkEnquiryDialog({
  enquiry,
  customerId,
  customerName,
  onOpenChange,
  onLinked,
}: {
  enquiry: CustomerPhoneEnquiry;
  customerId: string;
  customerName: string;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}) {
  const [requestId] = useState(createUuid);
  const mutation = useMutation({ mutationFn: resolveLeadCustomer, onSuccess: onLinked });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link enquiry to {customerName}?</DialogTitle>
          <DialogDescription>
            Lead {enquiry.lead_id.slice(0, 8).toUpperCase()} ({enquiry.customer_name}
            {enquiry.interested_model ? `, ${enquiry.interested_model}` : ''}) will appear in this
            Customer 360. The decision and its reason are recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-2 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            mutation.mutate({
              leadId: enquiry.lead_id,
              expectedLeadUpdatedAt: enquiry.updated_at,
              resolution: 'LINK_EXISTING',
              reason: String(form.get('reason') ?? ''),
              requestId,
              customerId,
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Reason <span className="text-destructive">(required)</span>
            <Input
              name="reason"
              defaultValue={LINK_REASON}
              minLength={3}
              maxLength={500}
              required
            />
          </label>
          {mutation.isError ? (
            <p className="text-sm text-destructive">
              The enquiry could not be linked. It may have changed or been linked elsewhere — close
              this and check the list again.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Linking…' : 'Link enquiry'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
