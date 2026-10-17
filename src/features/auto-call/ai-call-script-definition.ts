import { z } from 'zod';

// The script the AI agent follows on an auto call. Mirrors
// app_private.auto_ai_script_error (202610171573_ai_agent_auto_call.sql); keep
// both in step when a rule changes.

export const aiCallLanguages = [
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'ml-IN', label: 'Malayalam' },
] as const;

export type AiCallLanguage = (typeof aiCallLanguages)[number]['value'];

export const aiCallLanguageSchema = z.enum(['en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'ml-IN']);

export function aiCallLanguageLabel(value: string | null | undefined) {
  return aiCallLanguages.find((entry) => entry.value === value)?.label ?? value ?? '—';
}

/** CRM fields an answer can be suggested for. */
export const aiCallFields = [
  { value: 'interested_model', label: 'Interested model' },
  { value: 'variant', label: 'Variant' },
  { value: 'purchase_timeline', label: 'Purchase timeline' },
  { value: 'budget_max', label: 'Budget (max)' },
  { value: 'finance_required', label: 'Finance required' },
  { value: 'exchange_required', label: 'Exchange required' },
  { value: 'test_drive_required', label: 'Test drive required' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'callback_requested', label: 'Callback requested' },
  { value: 'not_interested', label: 'Not interested reason' },
] as const;

const aiCallFieldSchema = z.enum([
  'interested_model',
  'variant',
  'purchase_timeline',
  'budget_max',
  'finance_required',
  'exchange_required',
  'test_drive_required',
  'temperature',
  'callback_requested',
  'not_interested',
]);

/** Sarvam bulbul:v2 speakers the agent can use. */
export const aiCallVoices = [
  { value: 'anushka', label: 'Anushka (female)' },
  { value: 'manisha', label: 'Manisha (female)' },
  { value: 'vidya', label: 'Vidya (female)' },
  { value: 'arya', label: 'Arya (female)' },
  { value: 'abhilash', label: 'Abhilash (male)' },
  { value: 'karun', label: 'Karun (male)' },
  { value: 'hitesh', label: 'Hitesh (male)' },
] as const;

export const aiCallScriptSchema = z
  .object({
    agent_name: z.string().trim().min(1, 'Give the agent a name.').max(40),
    intro: z.string().trim().max(400).optional(),
    goal: z.string().trim().min(10, 'Describe the goal in a sentence.').max(800),
    languages: z.array(aiCallLanguageSchema).min(1, 'Choose at least one language.').max(6),
    default_language: aiCallLanguageSchema,
    voice: z
      .string()
      .regex(/^[a-z_]{2,40}$/)
      .optional(),
    questions: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
          ask: z.string().trim().min(3, 'Write the question.').max(300),
          field: aiCallFieldSchema.nullable(),
        }),
      )
      .min(1, 'Add at least one question.')
      .max(12),
    closing: z.string().trim().max(400).optional(),
  })
  .refine((script) => script.languages.includes(script.default_language), {
    path: ['default_language'],
    message: 'The default language must be one of the call languages.',
  })
  .refine(
    (script) =>
      new Set(script.questions.map((question) => question.id)).size === script.questions.length,
    { path: ['questions'], message: 'Each question needs its own id.' },
  );

export type AiCallScript = z.infer<typeof aiCallScriptSchema>;

export function starterAiCallScript(): AiCallScript {
  return {
    agent_name: 'Priya',
    intro: 'You recently enquired about a car with us.',
    goal: 'Understand which car the customer wants, when they plan to buy and whether they want a test drive, so a sales executive can follow up.',
    languages: ['en-IN', 'hi-IN', 'kn-IN'],
    default_language: 'en-IN',
    voice: 'anushka',
    questions: [
      { id: 'model', ask: 'Which car model are you interested in?', field: 'interested_model' },
      { id: 'timeline', ask: 'When are you planning to buy?', field: 'purchase_timeline' },
      { id: 'budget', ask: 'What budget do you have in mind?', field: 'budget_max' },
      {
        id: 'test_drive',
        ask: 'Would you like to take a test drive?',
        field: 'test_drive_required',
      },
    ],
    closing: '',
  };
}

export function newQuestionId(existing: { id: string }[]) {
  let index = existing.length + 1;
  while (existing.some((question) => question.id === `q${index}`)) index += 1;
  return `q${index}`;
}
