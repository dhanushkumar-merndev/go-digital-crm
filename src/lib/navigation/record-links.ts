/**
 * Where a record opens when you press it.
 *
 * There are two detail pages and they answer different questions. Customer 360
 * is the person: who they are, every lead they have ever had, their vehicles,
 * documents and bookings. The lead page is one opportunity: its calls, its
 * messages, its follow-ups, its appointments.
 *
 * Almost every workspace row — an appointment, a follow-up, a task, a test
 * drive, a quotation, a call — belongs to a lead, not to a person in general.
 * Sending all of them to Customer 360 meant pressing a follow-up landed you on
 * a page that could not tell you which of the customer's leads it was for, and
 * you had to find your way back down into the right lead by hand.
 *
 * So: a row that knows its lead opens that lead. A row that only knows the
 * customer opens the customer. Customer 360 stays reachable from the lead page
 * and from explicit "Open customer 360" actions, which is the direction that
 * actually adds information rather than losing it.
 */
export function recordDetailHref(
  role: string,
  record: { lead_id?: string | null; customer_id?: string | null },
) {
  if (record.lead_id) return `/${role}/leads/${record.lead_id}`;
  if (record.customer_id) return `/${role}/customers/${record.customer_id}`;
  return null;
}

export function customerDetailHref(role: string, customerId: string) {
  return `/${role}/customers/${customerId}`;
}

export function leadDetailHref(role: string, leadId: string) {
  return `/${role}/leads/${leadId}`;
}

/**
 * My Leads with one lead marked. `focus` alone only marks a row that is already
 * on the loaded page, and a dashboard lead is often several pages in, so the
 * customer's mobile goes in as the list search: the lead (or the phone group it
 * sits in) is then the result, and the focus marks and scrolls to it.
 */
export function myLeadsFocusHref(role: string, lead: { id: string; phone: string | null }) {
  const params = new URLSearchParams({ status: 'all' });
  const mobile = (lead.phone ?? '').replace(/\D/g, '').slice(-10);
  if (mobile.length === 10) params.set('q', mobile);
  params.set('focus', lead.id);
  return `/${role}/my-leads?${params.toString()}`;
}

export function notificationDetailHref(
  role: string,
  resourceType: string | null,
  resourceId: string | null,
) {
  if (!resourceId) return null;
  if (resourceType === 'followup')
    return `/${role}/follow-ups?status=all&q=${encodeURIComponent(resourceId)}&focus=${encodeURIComponent(resourceId)}`;
  if (resourceType === 'lead') return leadDetailHref(role, resourceId);
  if (resourceType === 'customer') return customerDetailHref(role, resourceId);
  return null;
}
