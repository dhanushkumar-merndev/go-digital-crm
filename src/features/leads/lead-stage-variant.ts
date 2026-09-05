import type { BadgeVariant } from '@/components/ui/badge';

/**
 * The one mapping from a lead's stage to a badge colour. Canonical table and the
 * reasoning behind it live in AGENTS.md 9.8.
 *
 * This exists because the same lead used to be three different colours
 * depending on where you looked at it: `Contacted` was amber on the Telecaller
 * dashboard and green in My Leads, `Transferred to Sales` was blue on the Sales
 * Consultant dashboard and green everywhere else, and `Lost` was red on both
 * dashboards while the list called it grey. Three local copies of "roughly this
 * mapping" is how that happens, so there is now only one.
 *
 * Every stage owns a distinct hue, so a stage can be told apart by colour alone
 * without reading the label. Adding a stage means adding a colour: reusing an
 * existing one puts two different stages behind the same swatch, which is the
 * thing this table exists to prevent.
 *
 * It accepts derived work-states alongside lifecycle values because the lists
 * render whichever of the two they hold, and a caller should not have to know
 * which family a string came from.
 */
export function leadStageVariant(stage: string | null | undefined): BadgeVariant {
  switch (stage) {
    // --- Lifecycle, in funnel order -------------------------------------
    case 'New':
      return 'info'; // blue
    case 'Contacted':
      return 'cyan';
    case 'Qualified':
      return 'teal';
    case 'Appointment Scheduled':
      return 'indigo';
    case 'Transferred to Sales':
      return 'success'; // emerald

    // --- Sales-stage events layered over the lifecycle -------------------
    case 'Follow-up':
      return 'warning'; // amber
    case 'Test Drive':
      return 'violet';
    case 'Quotation':
      return 'orange';
    case 'Booking':
      return 'default'; // brand tint: the money event

    // --- Derived work-states, rendered in the same column ----------------
    case 'NEW_TODAY':
      return 'sky';
    case 'PENDING':
      return 'yellow';
    // The one lead-side red, because it is the only state that means someone
    // is late rather than simply somewhere in the pipeline.
    case 'SLA_RISK':
      return 'rose';

    // `Lost` lands here on purpose. A lost lead is closed, not broken, and
    // colouring it red made a normal outcome read as an error in every list it
    // appeared in. Grey is also the safe default for a stage nothing knows yet.
    default:
      return 'secondary';
  }
}
