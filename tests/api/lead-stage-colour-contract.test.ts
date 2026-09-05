import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leadStageVariant } from '../../src/features/leads/lead-stage-variant';

const read = (path: string) => readFileSync(path, 'utf8');
const agents = read('AGENTS.md');
const stagesForPalette = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Follow-up',
  'Test Drive',
  'Quotation',
  'Booking',
  'Lost',
  'NEW_TODAY',
  'PENDING',
  'SLA_RISK',
];
const consumers = [
  'src/features/leads/lead-workspace.tsx',
  'src/features/dashboards/telecaller-dashboard.tsx',
  'src/features/dashboards/sales-consultant-dashboard.tsx',
];

describe('lead stage colours', () => {
  it('gives every stage the colour AGENTS.md 9.8 documents', () => {
    const expected: Record<string, string> = {
      New: 'info',
      Contacted: 'cyan',
      Qualified: 'teal',
      'Appointment Scheduled': 'indigo',
      'Transferred to Sales': 'success',
      'Follow-up': 'warning',
      'Test Drive': 'violet',
      Quotation: 'orange',
      Booking: 'default',
      Lost: 'secondary',
    };
    for (const [stage, variant] of Object.entries(expected))
      expect(leadStageVariant(stage)).toBe(variant);
  });

  it('gives every stage its own colour, so none is ambiguous by swatch', () => {
    const stages = [
      'New',
      'Contacted',
      'Qualified',
      'Appointment Scheduled',
      'Transferred to Sales',
      'Follow-up',
      'Test Drive',
      'Quotation',
      'Booking',
      'Lost',
      'NEW_TODAY',
      'PENDING',
      'SLA_RISK',
    ];
    const used = stages.map((stage) => leadStageVariant(stage));
    expect(new Set(used).size).toBe(stages.length);
  });

  it('backs every variant it returns with a real badge colour', () => {
    // A variant name with no entry in badgeVariants renders unstyled, which
    // looks like a missing badge rather than a wrong colour.
    const badge = read('src/components/ui/badge.tsx');
    for (const variant of new Set(stagesForPalette.map(leadStageVariant)))
      expect(badge).toContain(`${variant}:`);
  });

  it('colours the derived work-states', () => {
    // Deliberately adjacent to their lifecycle neighbours: sky beside New's
    // blue, yellow beside Follow-up's amber.
    expect(leadStageVariant('NEW_TODAY')).toBe('sky');
    expect(leadStageVariant('PENDING')).toBe('yellow');
    // The one lead-side red: the only state meaning a person is overdue.
    expect(leadStageVariant('SLA_RISK')).toBe('rose');
  });

  it('keeps Lost out of red', () => {
    // A lost lead is closed, not broken. Both dashboards used to paint it red
    // while the list called it grey.
    expect(leadStageVariant('Lost')).not.toBe('destructive');
  });

  it('falls back to grey rather than throwing on an unknown stage', () => {
    for (const unknown of ['', 'Whatever', null, undefined])
      expect(leadStageVariant(unknown)).toBe('secondary');
  });

  it('is the only mapping: no surface re-derives stage colours locally', () => {
    for (const file of consumers) {
      const source = read(file);
      expect(source).toContain('leadStageVariant');
      // The shapes the three local copies used before they were merged.
      expect(source).not.toMatch(/value === 'Contacted' \|\|/);
      expect(source).not.toMatch(/\[.*'Contacted', 'Qualified'\]\.includes/);
      expect(source).not.toMatch(/status === 'Contacted' \|\| status === 'PENDING'/);
    }
  });

  it('keeps schedule statuses as their own family', () => {
    // Mixing lead stages into the schedule mapping is what made
    // `Transferred to Sales` blue on one dashboard and green everywhere else.
    const consultant = read('src/features/dashboards/sales-consultant-dashboard.tsx');
    expect(consultant).toContain('function scheduleStatusVariant');
    const fn = consultant.slice(
      consultant.indexOf('function scheduleStatusVariant'),
      consultant.indexOf('/** Every link on this page'),
    );
    for (const leadStage of ['Contacted', 'Qualified', 'Lost']) expect(fn).not.toContain(leadStage);
  });

  it('documents both roles in one place', () => {
    expect(agents).toContain('### 9.8 Status colours (Telecaller and Sales Consultant)');
    expect(agents).toContain('Qualified is never at rest');
    expect(agents).toContain('src/features/leads/lead-stage-variant.ts');
  });
});
