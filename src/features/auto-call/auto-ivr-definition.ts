import { z } from 'zod';

// A Client Admin's auto-call question flow. The database validates a flow
// fully on publish (app_private.auto_ivr_definition_error); this schema only
// keeps a draft readable while it is being built.

export const autoIvrPromptSchema = z.object({
  text: z.string().max(500).optional().default(''),
  language: z.string().max(12).optional(),
  voice_id: z.string().max(40).optional(),
  audio_file_id: z.uuid().nullable().optional(),
});

export const autoIvrSetSchema = z.object({
  field: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

export const autoIvrOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  next: z.string(),
  sets: z.array(autoIvrSetSchema).optional().default([]),
});

export const autoIvrNodeSchema = z.object({
  title: z.string(),
  prompt: autoIvrPromptSchema,
  timeout_sec: z.number(),
  retries: z.number(),
  on_no_input: z.string(),
  options: z.array(autoIvrOptionSchema),
});

export const autoIvrDefinitionSchema = z.object({
  start: z.string(),
  greeting: autoIvrPromptSchema.optional(),
  goodbye: autoIvrPromptSchema,
  nodes: z.record(z.string(), autoIvrNodeSchema),
});

export type AutoIvrPrompt = z.infer<typeof autoIvrPromptSchema>;
export type AutoIvrSet = z.infer<typeof autoIvrSetSchema>;
export type AutoIvrOption = z.infer<typeof autoIvrOptionSchema>;
export type AutoIvrNode = z.infer<typeof autoIvrNodeSchema>;
export type AutoIvrDefinition = z.infer<typeof autoIvrDefinitionSchema>;

export const END_NODE = 'END';
export const ivrKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'] as const;

/** CRM fields an answer may suggest; each value is reviewed by the telecaller. */
export const autoIvrFields = [
  {
    field: 'temperature',
    label: 'Temperature',
    kind: 'choice',
    choices: [
      { value: 'HOT', label: 'Hot' },
      { value: 'WARM', label: 'Warm' },
      { value: 'COLD', label: 'Cold' },
    ],
  },
  { field: 'purchase_timeline', label: 'Purchase timeline', kind: 'text' },
  { field: 'interested_model', label: 'Interested model', kind: 'text' },
  { field: 'finance_required', label: 'Finance required', kind: 'boolean' },
  { field: 'exchange_required', label: 'Exchange required', kind: 'boolean' },
  { field: 'test_drive_required', label: 'Test drive required', kind: 'boolean' },
  { field: 'not_interested', label: 'Not interested (mark Lost)', kind: 'text' },
  { field: 'callback_requested', label: 'Callback requested', kind: 'flag' },
] as const;

export type AutoIvrFieldKey = (typeof autoIvrFields)[number]['field'];

// Fields only the AI agent suggests; keypad options cannot set them.
const aiOnlyFieldLabels: Record<string, string> = {
  variant: 'Variant',
  budget_max: 'Budget (max)',
};

export function autoIvrFieldLabel(field: string) {
  return (
    autoIvrFields.find((entry) => entry.field === field)?.label ?? aiOnlyFieldLabels[field] ?? field
  );
}

export function displayFieldValue(field: string, value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (field === 'callback_requested') return value === true ? 'Yes' : 'No';
  // Suggested only when the customer asked not to be called (AGENTS.md 9.7).
  if (field === 'temperature' && value === 'DORMANT') return 'Dormant (do not contact)';
  if (field === 'budget_max' && (typeof value === 'number' || typeof value === 'string'))
    return `₹${Number(value).toLocaleString('en-IN')}`;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const entry = autoIvrFields.find((item) => item.field === field);
  if (entry?.kind === 'choice')
    return entry.choices.find((choice) => choice.value === value)?.label ?? String(value);
  return String(value);
}

export function defaultSetValue(field: string): string | boolean {
  const entry = autoIvrFields.find((item) => item.field === field);
  if (!entry) return '';
  if (entry.kind === 'boolean' || entry.kind === 'flag') return true;
  if (entry.kind === 'choice') return entry.choices[0].value;
  return '';
}

export function newNodeId(definition: AutoIvrDefinition) {
  for (let index = Object.keys(definition.nodes).length + 1; index < 100; index += 1) {
    const id = `q${index}`;
    if (!definition.nodes[id]) return id;
  }
  return `q${Date.now().toString(36)}`;
}

export function blankQuestion(title = 'New question'): AutoIvrNode {
  return {
    title,
    prompt: { text: '' },
    timeout_sec: 6,
    retries: 1,
    on_no_input: END_NODE,
    options: [
      { key: '1', label: 'Yes', next: END_NODE, sets: [] },
      { key: '2', label: 'No', next: END_NODE, sets: [] },
    ],
  };
}

/** A working starting point the Client Admin edits. */
export function starterDefinition(): AutoIvrDefinition {
  return {
    start: 'q1',
    greeting: {
      text: 'Hello, this is an automated call from our dealership about your car enquiry.',
    },
    goodbye: { text: 'Thank you. Our team will call you soon. Goodbye.' },
    nodes: {
      q1: {
        title: 'Still interested',
        prompt: {
          text: 'Are you still interested in buying a car? Press 1 for yes, 2 for no, 3 to get a call back later.',
        },
        timeout_sec: 6,
        retries: 1,
        on_no_input: END_NODE,
        options: [
          {
            key: '1',
            label: 'Interested',
            next: 'q2',
            sets: [{ field: 'temperature', value: 'WARM' }],
          },
          {
            key: '2',
            label: 'Not interested',
            next: END_NODE,
            sets: [{ field: 'not_interested', value: 'Not interested (auto call)' }],
          },
          {
            key: '3',
            label: 'Call me later',
            next: END_NODE,
            sets: [{ field: 'callback_requested', value: true }],
          },
        ],
      },
      q2: {
        title: 'When buying',
        prompt: {
          text: 'When do you plan to buy? Press 1 for this month, 2 for one to three months, 3 for later.',
        },
        timeout_sec: 6,
        retries: 1,
        on_no_input: 'q3',
        options: [
          {
            key: '1',
            label: 'This month',
            next: 'q3',
            sets: [
              { field: 'purchase_timeline', value: 'This month' },
              { field: 'temperature', value: 'HOT' },
            ],
          },
          {
            key: '2',
            label: '1-3 months',
            next: 'q3',
            sets: [{ field: 'purchase_timeline', value: '1-3 months' }],
          },
          {
            key: '3',
            label: 'Later',
            next: 'q3',
            sets: [
              { field: 'purchase_timeline', value: 'Later' },
              { field: 'temperature', value: 'COLD' },
            ],
          },
        ],
      },
      q3: {
        title: 'Test drive',
        prompt: { text: 'Would you like a test drive? Press 1 for yes, 2 for no.' },
        timeout_sec: 6,
        retries: 1,
        on_no_input: END_NODE,
        options: [
          {
            key: '1',
            label: 'Wants a test drive',
            next: END_NODE,
            sets: [{ field: 'test_drive_required', value: true }],
          },
          {
            key: '2',
            label: 'No test drive',
            next: END_NODE,
            sets: [{ field: 'test_drive_required', value: false }],
          },
        ],
      },
    },
  };
}

/** Removes a question and points every link to it at END. */
export function removeQuestion(definition: AutoIvrDefinition, nodeId: string): AutoIvrDefinition {
  const nodes = Object.fromEntries(
    Object.entries(definition.nodes)
      .filter(([id]) => id !== nodeId)
      .map(([id, node]) => [
        id,
        {
          ...node,
          on_no_input: node.on_no_input === nodeId ? END_NODE : node.on_no_input,
          options: node.options.map((option) =>
            option.next === nodeId ? { ...option, next: END_NODE } : option,
          ),
        },
      ]),
  );
  const remaining = Object.keys(nodes);
  return {
    ...definition,
    nodes,
    start: definition.start === nodeId ? (remaining[0] ?? '') : definition.start,
  };
}
