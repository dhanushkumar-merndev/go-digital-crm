-- SAME_CUSTOMER records an assignment made because the customer already had an
-- owner: a new enquiry kept with the telecaller or Sales Consultant already
-- handling that mobile, or an untouched sibling lead taken over by the
-- telecaller who contacted the customer first.
--
-- It is an assignment-history method only. Teams never run in this mode, so the
-- frontend's assignmentModes (the team mode picker) deliberately leaves it out.
--
-- Kept in its own file with no transaction block: a new enum value cannot be
-- used in the transaction that adds it, and 202610090502 uses it.

alter type public.assignment_mode add value if not exists 'SAME_CUSTOMER';
