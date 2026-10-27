export const colors = {
  // Navy and sky come from the Go Digital logo.
  navy: '#14254a',
  sky: '#8cc0f8',
  primary: '#1d4ed8',
  primarySoft: '#eef3fe',
  background: '#f5f6f8',
  card: '#ffffff',
  pressed: '#f1f3f6',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  border: '#e5e7eb',
  danger: '#dc2626',
  dangerSoft: '#fef2f2',
  warning: '#d97706',
  warningSoft: '#fffbeb',
  success: '#059669',
  successSoft: '#ecfdf5',
  whatsapp: '#16a34a',
  // White text and icons on a filled colour (buttons, swipe actions, banners).
  onColor: '#ffffff',
  // Borders and strong text for the tinted states above. Screens used to type
  // these hexes inline, a shade apart from one screen to the next.
  dangerBorder: '#fecaca',
  dangerStrong: '#b91c1c',
  dangerDeep: '#991b1b',
  warningBorder: '#fde68a',
  warningStrong: '#b45309',
  warningDeep: '#92400e',
  successStrong: '#047857',
  infoSoft: '#eff6ff',
  infoBorder: '#dbeafe',
  infoBorderStrong: '#bfdbfe',
  violet: '#7c3aed',
  violetStrong: '#6d28d9',
  subtle: '#f1f5f9',
  scrim: '#000000',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 10, lg: 12, pill: 999 } as const;

// The only font sizes the app uses. Screens had drifted to 17 literal sizes,
// from 9 to 30; nothing on a phone should read smaller than `caption`.
export const font = {
  caption: 11,
  label: 12,
  small: 13,
  row: 14,
  body: 15,
  heading: 17,
  title: 18,
  large: 20,
  display: 24,
  hero: 26,
} as const;

export const type = {
  hero: { fontSize: font.hero, fontWeight: '700', letterSpacing: -0.4 },
  title: { fontSize: font.title, fontWeight: '700', letterSpacing: -0.2 },
  body: { fontSize: font.body, fontWeight: '500' },
  small: { fontSize: font.small, fontWeight: '500' },
  tiny: { fontSize: font.caption, fontWeight: '700' },
} as const;

// Surfaces separate by a hairline border, not a drop shadow: flatter, and
// cheaper to draw while a list scrolls.
export const shadow = {
  borderWidth: 1,
  borderColor: colors.border,
} as const;

export type Tone = { fg: string; bg: string };

// AGENTS.md 9.8: one colour per lead stage, shared with the web badges.
const stageTones: Record<string, Tone> = {
  New: { fg: '#1d4ed8', bg: '#eff6ff' },
  Contacted: { fg: '#0e7490', bg: '#ecfeff' },
  Qualified: { fg: '#0f766e', bg: '#f0fdfa' },
  'Appointment Scheduled': { fg: '#4338ca', bg: '#eef2ff' },
  'Transferred to Sales': { fg: '#047857', bg: '#ecfdf5' },
  'Follow-up': { fg: '#b45309', bg: '#fffbeb' },
  'Test Drive': { fg: '#6d28d9', bg: '#f5f3ff' },
  Quotation: { fg: '#c2410c', bg: '#fff7ed' },
  Booking: { fg: colors.primary, bg: '#2563eb1a' },
  NEW_TODAY: { fg: '#0369a1', bg: '#f0f9ff' },
  PENDING: { fg: '#854d0e', bg: '#fefce8' },
  SLA_RISK: { fg: '#be123c', bg: '#fff1f2' },
};
const neutral: Tone = { fg: '#4b5563', bg: '#f3f4f6' };

export function stageTone(stage: string | null | undefined): Tone {
  return (stage && stageTones[stage]) || neutral;
}

// AGENTS.md 9.7: temperature is its own axis and never shares the stage scale.
export function temperatureTone(value: string | null | undefined): Tone {
  if (value === 'HOT') return { fg: '#dc2626', bg: '#fef2f2' };
  if (value === 'WARM') return { fg: '#d97706', bg: '#fffbeb' };
  if (value === 'COLD') return { fg: '#2563eb', bg: '#eff6ff' };
  return neutral;
}

export function priorityTone(priority: string | null | undefined): Tone {
  if (priority === 'URGENT' || priority === 'HIGH') return { fg: '#dc2626', bg: '#fef2f2' };
  if (priority === 'NORMAL') return { fg: '#d97706', bg: '#fffbeb' };
  return { fg: '#2563eb', bg: '#eff6ff' };
}

// URGENT reads "Urgent" and HOT "Hot", in sentence case like every other badge.
export function enumLabel(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
