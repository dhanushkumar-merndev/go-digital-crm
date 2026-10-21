import type { FilterGroup } from '@/components/ui/filter-sheet';

// Values are exactly what the web workspaces send to the same RPCs
// (src/features/{leads,work,calls}/*-query.ts), so both apps filter alike.

const all = { value: 'all', label: 'All' } as const;

// Canonical lead sources (AGENTS.md 9.2).
export const leadSourceOptions = [
  all,
  ...[
    'Facebook',
    'Instagram',
    'Google Ads',
    'Website',
    'WhatsApp Business',
    'CarWale',
    'CarDekho',
    'Justdial',
    'IndiaMART',
    'Manual',
    'Other',
  ].map((value) => ({ value, label: value })),
];

const leadStageOptions = [
  all,
  ...[
    'New',
    'Contacted',
    'Qualified',
    'Appointment Scheduled',
    'Transferred to Sales',
    'Test Drive',
    'Quotation',
    'Booking',
    'Lost',
  ].map((value) => ({ value, label: value })),
];

const buyerTypeOptions = [
  all,
  { value: 'INDIVIDUAL', label: 'Individual' },
  { value: 'COMPANY', label: 'Company' },
];

const priorityOptions = [
  all,
  { value: 'URGENT', label: 'Urgent' },
  { value: 'HIGH', label: 'High' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'LOW', label: 'Low' },
];

const modelGroup: FilterGroup = {
  key: 'model',
  label: 'Model',
  kind: 'text',
  placeholder: 'e.g. Nexon',
};

export const leadFilterGroups: FilterGroup[] = [
  { key: 'stage', label: 'Stage', kind: 'choice', options: leadStageOptions },
  { key: 'source', label: 'Source', kind: 'choice', options: leadSourceOptions },
  modelGroup,
  { key: 'followup', label: 'Next follow-up', kind: 'dates' },
  {
    key: 'created',
    label: 'Enquiry date',
    kind: 'dates',
    options: ['any', 'today', 'past7', 'month'],
  },
  { key: 'buyer', label: 'Buyer', kind: 'choice', options: buyerTypeOptions },
];

export const followupFilterGroups: FilterGroup[] = [
  { key: 'priority', label: 'Priority', kind: 'choice', options: priorityOptions },
  {
    key: 'temperature',
    label: 'Buying intent',
    kind: 'choice',
    options: [
      all,
      { value: 'HOT', label: 'Hot' },
      { value: 'WARM', label: 'Warm' },
      { value: 'COLD', label: 'Cold' },
    ],
  },
  { key: 'source', label: 'Source', kind: 'choice', options: leadSourceOptions },
  modelGroup,
  { key: 'due', label: 'Due', kind: 'dates' },
  { key: 'buyer', label: 'Buyer', kind: 'choice', options: buyerTypeOptions },
];

// Tasks take upper-case priorities, 'ALL' included.
export const taskFilterGroups: FilterGroup[] = [
  {
    key: 'priority',
    label: 'Priority',
    kind: 'choice',
    options: priorityOptions.map((option) =>
      option.value === 'all' ? { value: 'ALL', label: 'All' } : option,
    ),
  },
];

export const callFilterGroups: FilterGroup[] = [
  {
    key: 'view',
    label: 'Show',
    kind: 'choice',
    options: [
      { value: 'HISTORY', label: 'All calls' },
      { value: 'TODAY', label: 'Today' },
      { value: 'MISSED', label: 'Missed' },
      { value: 'RECORDINGS', label: 'With recording' },
      { value: 'AI', label: 'With AI summary' },
    ],
  },
  {
    key: 'outcome',
    label: 'Outcome',
    kind: 'choice',
    options: [
      { value: 'ALL', label: 'All' },
      { value: 'CONNECTED', label: 'Connected' },
      { value: 'NO_ANSWER', label: 'No answer' },
      { value: 'BUSY', label: 'Busy' },
      { value: 'SWITCHED_OFF', label: 'Switched off' },
      { value: 'CALLBACK_REQUIRED', label: 'Call back' },
      { value: 'WRONG_NUMBER', label: 'Wrong number' },
      { value: 'OTHER', label: 'Other' },
    ],
  },
  {
    key: 'source',
    label: 'Placed from',
    kind: 'choice',
    options: [
      { value: 'ALL', label: 'All' },
      { value: 'PERSONAL_MANUAL', label: 'My phone' },
      { value: 'PROVIDER', label: 'IVR' },
    ],
  },
];

export const visitFilterGroups: FilterGroup[] = [
  {
    key: 'type',
    label: 'Visit type',
    kind: 'choice',
    options: [
      all,
      { value: 'Showroom Visit', label: 'Showroom visit' },
      { value: 'Video Call', label: 'Video call' },
      { value: 'Consultant Call', label: 'Consultant call' },
    ],
  },
];

export const testDriveFilterGroups: FilterGroup[] = [
  modelGroup,
  {
    key: 'date',
    label: 'Date',
    kind: 'dates',
    options: ['any', 'today', 'next7', 'past7', 'month'],
  },
];

/** Search text the RPCs accept: letters, digits, spaces, + and -. */
export function safeSearch(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9\s+-]/g, '')
    .slice(0, 80);
}

/** 'all'/'ALL' and empty text mean "no filter" to the RPCs that take null. */
export function orNull(value: string | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed && trimmed.toLowerCase() !== 'all' ? trimmed : null;
}
