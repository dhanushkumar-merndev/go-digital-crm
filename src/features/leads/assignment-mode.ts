/**
 * How a team hands out leads. Mirrors the `public.assignment_mode` enum; a value
 * in the database that is missing here fails every zod parse that reads it, so
 * add new modes in the same change as the enum.
 *
 * - ROUND_ROBIN: the next member in rotation (whoever has waited longest).
 * - LEAST_ASSIGNED: the member carrying the fewest open leads in the team.
 * - MANUAL_ASSIGNMENT: a person picks the assignee.
 */
export const assignmentModes = ['ROUND_ROBIN', 'LEAST_ASSIGNED', 'MANUAL_ASSIGNMENT'] as const;

export type AssignmentMode = (typeof assignmentModes)[number];

const labels: Record<AssignmentMode, string> = {
  ROUND_ROBIN: 'Round Robin',
  LEAST_ASSIGNED: 'Least Assigned',
  MANUAL_ASSIGNMENT: 'Manual Assignment',
};

const descriptions: Record<AssignmentMode, string> = {
  ROUND_ROBIN: 'next member in rotation',
  LEAST_ASSIGNED: 'fewest open leads',
  MANUAL_ASSIGNMENT: 'chosen by a person',
};

/**
 * Assignment-history methods that are not team modes. SAME_CUSTOMER records a
 * lead kept with, or taken over by, the person already handling the customer.
 * Teams never run in it, so it stays out of assignmentModes and the pickers.
 */
const historyOnlyLabels: Record<string, string> = {
  SAME_CUSTOMER: 'Same customer',
};

export function isAssignmentMode(value: string): value is AssignmentMode {
  return (assignmentModes as readonly string[]).includes(value);
}

/** Accepts any string because assignment history rows carry the method as text. */
export function assignmentModeLabel(value: string): string {
  return isAssignmentMode(value) ? labels[value] : (historyOnlyLabels[value] ?? value);
}

export function assignmentModeDescription(value: string): string {
  return isAssignmentMode(value) ? descriptions[value] : '';
}

/** The CRM, not a person, chooses the assignee. */
export function isAutomaticAssignmentMode(value: string): boolean {
  return value === 'ROUND_ROBIN' || value === 'LEAST_ASSIGNED';
}
