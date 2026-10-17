// Website chat widget + Lead API: configuration, answer validation and the
// mapping onto the canonical lead. Shared by the Edge Functions (Deno imports
// this file by relative path) and the web UI, so it stays dependency-free.

export const WEBSITE_PROVIDER_KEY = 'website';

export const websiteQuestionFields = [
  'customer_name',
  'phone',
  'email',
  'interested_model',
  'variant',
  'fuel_type',
  'transmission',
  'budget',
  'purchase_timeline',
  'preferred_branch',
  'city',
  'finance_required',
  'exchange_required',
  'test_drive_required',
  'preferred_contact_time',
  'custom',
] as const;
export type WebsiteQuestionField = (typeof websiteQuestionFields)[number];

export const websiteQuestionTypes = [
  'text',
  'phone',
  'email',
  'choice',
  'yes_no',
  'model_picker',
  'branch_picker',
] as const;
export type WebsiteQuestionType = (typeof websiteQuestionTypes)[number];

export type WebsiteQuestion = {
  id: string;
  field: WebsiteQuestionField;
  type: WebsiteQuestionType;
  prompt: string;
  options: string[];
  required: boolean;
};

export type WebsiteWidgetConfig = {
  widget_enabled: boolean;
  api_enabled: boolean;
  title: string;
  greeting: string;
  success_message: string;
  accent_color: string;
  allowed_origins: string[];
  questions: WebsiteQuestion[];
};

export type WebsiteLeadRequirements = {
  variant?: string;
  fuel_type?: string;
  transmission?: string;
  purchase_timeline?: string;
  budget_min?: number;
  budget_max?: number;
  finance_required?: boolean;
  exchange_required?: boolean;
  test_drive_required?: boolean;
};

export type WebsiteTranscriptEntry = { id: string; question: string; answer: string };

type FieldSpec = {
  label: string;
  type: WebsiteQuestionType;
  prompt: string;
  options?: string[];
  // Options map onto typed requirement values, so the admin cannot edit them.
  fixedOptions?: boolean;
};

export const budgetRanges: { label: string; min: number; max?: number }[] = [
  { label: 'Under ₹5 lakh', min: 0, max: 500_000 },
  { label: '₹5–10 lakh', min: 500_000, max: 1_000_000 },
  { label: '₹10–15 lakh', min: 1_000_000, max: 1_500_000 },
  { label: '₹15–25 lakh', min: 1_500_000, max: 2_500_000 },
  { label: 'Above ₹25 lakh', min: 2_500_000 },
];

export const websiteFieldSpecs: Record<WebsiteQuestionField, FieldSpec> = {
  customer_name: { label: 'Name', type: 'text', prompt: 'Hi! May I know your name?' },
  phone: {
    label: 'Mobile number',
    type: 'phone',
    prompt: 'Thanks! What is your mobile number so our team can reach you?',
  },
  email: { label: 'Email', type: 'email', prompt: 'Your email address (optional)?' },
  interested_model: {
    label: 'Interested model',
    type: 'model_picker',
    prompt: 'Which car are you interested in?',
  },
  variant: { label: 'Variant', type: 'text', prompt: 'Any preferred variant?' },
  fuel_type: {
    label: 'Fuel type',
    type: 'choice',
    prompt: 'Which fuel type do you prefer?',
    options: ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'],
  },
  transmission: {
    label: 'Transmission',
    type: 'choice',
    prompt: 'Manual or automatic?',
    options: ['Manual', 'Automatic'],
  },
  budget: {
    label: 'Budget',
    type: 'choice',
    prompt: 'What is your budget?',
    options: budgetRanges.map((range) => range.label),
    fixedOptions: true,
  },
  purchase_timeline: {
    label: 'Purchase timeline',
    type: 'choice',
    prompt: 'When are you planning to buy?',
    options: ['Immediately', 'Within 1 month', '1–3 months', '3–6 months', 'Just exploring'],
  },
  preferred_branch: {
    label: 'Preferred showroom',
    type: 'branch_picker',
    prompt: 'Which showroom is convenient for you?',
  },
  city: { label: 'City', type: 'text', prompt: 'Which city are you in?' },
  finance_required: {
    label: 'Finance required',
    type: 'yes_no',
    prompt: 'Would you like a car loan / finance option?',
  },
  exchange_required: {
    label: 'Exchange',
    type: 'yes_no',
    prompt: 'Do you have a car to exchange?',
  },
  test_drive_required: {
    label: 'Test drive',
    type: 'yes_no',
    prompt: 'Would you like to book a test drive?',
  },
  preferred_contact_time: {
    label: 'Preferred call time',
    type: 'choice',
    prompt: 'When should we call you?',
    options: ['Morning', 'Afternoon', 'Evening'],
  },
  custom: { label: 'Custom question', type: 'text', prompt: 'Your question here' },
};

export const lockedWebsiteFields: readonly WebsiteQuestionField[] = ['customer_name', 'phone'];
export const customQuestionTypes: readonly WebsiteQuestionType[] = ['text', 'choice', 'yes_no'];

export const WEBSITE_LIMITS = {
  maxQuestions: 20,
  maxOptions: 12,
  maxOrigins: 20,
  maxAnswerLength: 200,
  maxSubmissionBytes: 16_000,
} as const;

export function websiteQuestion(
  field: WebsiteQuestionField,
  overrides: Partial<WebsiteQuestion> = {},
): WebsiteQuestion {
  const spec = websiteFieldSpecs[field];
  return {
    id: overrides.id ?? field,
    field,
    type: overrides.type ?? spec.type,
    prompt: overrides.prompt ?? spec.prompt,
    options: overrides.options ?? spec.options ?? [],
    required: lockedWebsiteFields.includes(field) ? true : (overrides.required ?? false),
  };
}

export function defaultWebsiteQuestions(): WebsiteQuestion[] {
  return [
    websiteQuestion('customer_name'),
    websiteQuestion('phone'),
    websiteQuestion('interested_model', { required: true }),
    websiteQuestion('budget'),
    websiteQuestion('purchase_timeline'),
    websiteQuestion('preferred_branch'),
    websiteQuestion('exchange_required'),
    websiteQuestion('finance_required'),
    websiteQuestion('test_drive_required'),
  ];
}

export function defaultWebsiteWidgetConfig(): WebsiteWidgetConfig {
  return {
    widget_enabled: true,
    api_enabled: true,
    title: 'Chat with us',
    greeting:
      'Hello! Looking for a new car? Answer a few quick questions and our team will call you.',
    success_message: 'Thank you! Our team will call you shortly.',
    accent_color: '#2563eb',
    allowed_origins: [],
    questions: defaultWebsiteQuestions(),
  };
}

// --- Config validation --------------------------------------------------------

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

const originPattern =
  /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

// Origins are compared exactly, so normalise what admins paste ("www.x.com/", "HTTPS://X.com").
export function normalizeWebsiteOrigin(value: string): string | null {
  let candidate = value.trim().toLowerCase().replace(/\/+$/, '');
  if (!candidate) return null;
  if (!/^https?:\/\//.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    candidate = url.origin;
  } catch {
    return null;
  }
  if (!originPattern.test(candidate)) return null;
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(candidate);
  if (candidate.startsWith('http://') && !isLocal) return null;
  return candidate;
}

export function parseWebsiteWidgetConfig(input: unknown): Result<WebsiteWidgetConfig> {
  const source = record(input);
  if (!source) return { ok: false, error: 'Widget settings are missing.' };
  const title = cleanText(source.title, 60);
  const greeting = cleanText(source.greeting, 240);
  const successMessage = cleanText(source.success_message, 240);
  if (!title) return { ok: false, error: 'Enter a widget title (up to 60 characters).' };
  if (!greeting) return { ok: false, error: 'Enter a greeting (up to 240 characters).' };
  if (!successMessage)
    return { ok: false, error: 'Enter a thank-you message (up to 240 characters).' };
  const accent = typeof source.accent_color === 'string' ? source.accent_color.trim() : '';
  if (!/^#[0-9a-fA-F]{6}$/.test(accent))
    return { ok: false, error: 'Accent colour must be a hex value like #2563eb.' };

  const rawOrigins = Array.isArray(source.allowed_origins) ? source.allowed_origins : [];
  if (rawOrigins.length > WEBSITE_LIMITS.maxOrigins)
    return { ok: false, error: `Add at most ${WEBSITE_LIMITS.maxOrigins} website domains.` };
  const origins: string[] = [];
  for (const raw of rawOrigins) {
    const origin = typeof raw === 'string' ? normalizeWebsiteOrigin(raw) : null;
    if (!origin)
      return { ok: false, error: `"${String(raw)}" is not a valid https website domain.` };
    if (!origins.includes(origin)) origins.push(origin);
  }
  const widgetEnabled = source.widget_enabled !== false;
  if (widgetEnabled && origins.length === 0)
    return { ok: false, error: 'Add at least one website domain where the chat widget will run.' };

  const rawQuestions = Array.isArray(source.questions) ? source.questions : [];
  if (rawQuestions.length < 2 || rawQuestions.length > WEBSITE_LIMITS.maxQuestions)
    return { ok: false, error: `Use between 2 and ${WEBSITE_LIMITS.maxQuestions} questions.` };
  const questions: WebsiteQuestion[] = [];
  const seenIds = new Set<string>();
  const seenFields = new Set<WebsiteQuestionField>();
  for (const raw of rawQuestions) {
    const question = record(raw);
    if (!question) return { ok: false, error: 'A question is malformed.' };
    const field = question.field as WebsiteQuestionField;
    if (!websiteQuestionFields.includes(field))
      return { ok: false, error: 'A question uses an unknown field.' };
    const spec = websiteFieldSpecs[field];
    const id = typeof question.id === 'string' ? question.id : '';
    if (!/^[a-z0-9_-]{1,40}$/.test(id) || seenIds.has(id))
      return { ok: false, error: 'Each question needs a unique id.' };
    if (field !== 'custom' && seenFields.has(field))
      return { ok: false, error: `"${spec.label}" can only be asked once.` };
    const type =
      field === 'custom'
        ? (question.type as WebsiteQuestionType)
        : (spec.type as WebsiteQuestionType);
    if (field === 'custom' && !customQuestionTypes.includes(type))
      return { ok: false, error: 'A custom question has an unsupported answer type.' };
    const prompt = cleanText(question.prompt, 200);
    if (!prompt) return { ok: false, error: `Enter the question text for "${spec.label}".` };
    let options: string[] = [];
    if (type === 'choice') {
      if (spec.fixedOptions) options = [...(spec.options ?? [])];
      else {
        const rawOptions = Array.isArray(question.options) ? question.options : [];
        options = [
          ...new Set(
            rawOptions
              .map((option) => cleanText(option, 60))
              .filter((option): option is string => Boolean(option)),
          ),
        ];
        if (options.length < 2 || options.length > WEBSITE_LIMITS.maxOptions)
          return {
            ok: false,
            error: `"${prompt}" needs 2 to ${WEBSITE_LIMITS.maxOptions} answer options.`,
          };
      }
    }
    seenIds.add(id);
    seenFields.add(field);
    questions.push({
      id,
      field,
      type,
      prompt,
      options,
      required: lockedWebsiteFields.includes(field) ? true : question.required === true,
    });
  }
  for (const field of lockedWebsiteFields)
    if (!seenFields.has(field))
      return { ok: false, error: `The "${websiteFieldSpecs[field].label}" question is required.` };

  return {
    ok: true,
    value: {
      widget_enabled: widgetEnabled,
      api_enabled: source.api_enabled !== false,
      title,
      greeting,
      success_message: successMessage,
      accent_color: accent.toLowerCase(),
      allowed_origins: origins,
      questions,
    },
  };
}

// --- Answers ------------------------------------------------------------------

export function normalizeWebsitePhone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 20 || !/^[0-9+()., -]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+'))
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  const local = digits.replace(/^0+/, '');
  if (local.length === 10) return /^[6-9]/.test(local) ? `+91${local}` : null;
  if (local.length === 12 && local.startsWith('91')) return `+${local}`;
  return null;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function yesNo(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'y', 'true'].includes(normalized)) return true;
  if (['no', 'n', 'false'].includes(normalized)) return false;
  return undefined;
}

export const MODEL_NOT_SURE = 'Not sure yet';

export type WebsiteAnswerContext = {
  models: string[];
  branches: { id: string; name: string }[];
};

export type MappedWebsiteLead = {
  customer_name: string;
  phone: string;
  email?: string;
  interested_model?: string;
  branch_id?: string;
  requirements: WebsiteLeadRequirements;
  transcript: WebsiteTranscriptEntry[];
};

export type AnswerError = { ok: false; error: string; question_id: string };

// Validates one answer. Returns the stored value (string | boolean) or an error message.
export function validateWebsiteAnswer(
  question: WebsiteQuestion,
  value: unknown,
  context: WebsiteAnswerContext,
):
  | { ok: true; value: string | boolean | undefined; display?: string }
  | { ok: false; error: string } {
  const empty =
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  if (empty) {
    return question.required
      ? { ok: false, error: 'This answer is required.' }
      : { ok: true, value: undefined };
  }
  switch (question.type) {
    case 'phone': {
      const phone = typeof value === 'string' ? normalizeWebsitePhone(value) : null;
      return phone
        ? { ok: true, value: phone }
        : { ok: false, error: 'Enter a valid mobile number.' };
    }
    case 'email': {
      const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return email.length <= 254 && emailPattern.test(email)
        ? { ok: true, value: email }
        : { ok: false, error: 'Enter a valid email address.' };
    }
    case 'yes_no': {
      const answer = yesNo(value);
      return answer === undefined
        ? { ok: false, error: 'Choose yes or no.' }
        : { ok: true, value: answer, display: answer ? 'Yes' : 'No' };
    }
    case 'choice': {
      const answer = typeof value === 'string' ? value.trim() : '';
      return question.options.includes(answer)
        ? { ok: true, value: answer }
        : { ok: false, error: 'Choose one of the options.' };
    }
    case 'model_picker': {
      const answer = cleanText(value, 160);
      if (!answer) return { ok: false, error: 'Choose a model.' };
      if (
        context.models.length > 0 &&
        answer !== MODEL_NOT_SURE &&
        !context.models.includes(answer)
      )
        return { ok: false, error: 'Choose one of the listed models.' };
      return { ok: true, value: answer };
    }
    case 'branch_picker': {
      const branch = context.branches.find((candidate) => candidate.id === value);
      return branch
        ? { ok: true, value: branch.id, display: branch.name }
        : { ok: false, error: 'Choose a showroom.' };
    }
    default: {
      const minimum = question.field === 'customer_name' ? 2 : 1;
      const answer = cleanText(
        value,
        question.field === 'customer_name' ? 160 : WEBSITE_LIMITS.maxAnswerLength,
      );
      return answer && answer.length >= minimum
        ? { ok: true, value: answer }
        : { ok: false, error: 'Enter a valid answer.' };
    }
  }
}

export function mapWebsiteChatAnswers(
  config: WebsiteWidgetConfig,
  answers: unknown,
  context: WebsiteAnswerContext,
): { ok: true; value: MappedWebsiteLead } | AnswerError {
  const source = record(answers) ?? {};
  const mapped: Partial<MappedWebsiteLead> & { requirements: WebsiteLeadRequirements } = {
    requirements: {},
    transcript: [],
  };
  for (const question of config.questions) {
    const result = validateWebsiteAnswer(question, source[question.id], context);
    if (!result.ok) return { ok: false, error: result.error, question_id: question.id };
    if (result.value === undefined) continue;
    const value = result.value;
    mapped.transcript!.push({
      id: question.id,
      question: question.prompt,
      answer: result.display ?? String(value),
    });
    const text = typeof value === 'string' ? value : undefined;
    switch (question.field) {
      case 'customer_name':
        mapped.customer_name = text;
        break;
      case 'phone':
        mapped.phone = text;
        break;
      case 'email':
        mapped.email = text;
        break;
      case 'interested_model':
        if (text && text !== MODEL_NOT_SURE) mapped.interested_model = text;
        break;
      case 'preferred_branch':
        mapped.branch_id = text;
        break;
      case 'budget': {
        const range = budgetRanges.find((candidate) => candidate.label === text);
        if (range) {
          mapped.requirements.budget_min = range.min;
          if (range.max !== undefined) mapped.requirements.budget_max = range.max;
        }
        break;
      }
      case 'variant':
      case 'fuel_type':
      case 'transmission':
      case 'purchase_timeline':
        mapped.requirements[question.field] = text;
        break;
      case 'finance_required':
      case 'exchange_required':
      case 'test_drive_required':
        mapped.requirements[question.field] = value === true;
        break;
      default:
        break;
    }
  }
  if (!mapped.customer_name || !mapped.phone)
    return { ok: false, error: 'Name and mobile number are required.', question_id: 'phone' };
  return { ok: true, value: mapped as MappedWebsiteLead };
}

// --- Lead API payload -----------------------------------------------------------

export type LeadApiPayload = {
  customer_name: string;
  phone: string;
  email?: string;
  interested_model?: string;
  campaign?: string;
  source_detail?: string;
  branch_code?: string;
  external_lead_id?: string;
  city?: string;
  message?: string;
  requirements: WebsiteLeadRequirements;
};

function optionalText(
  source: Record<string, unknown>,
  key: string,
  max: number,
): Result<string | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''))
    return { ok: true, value: undefined };
  const value = cleanText(raw, max);
  return value
    ? { ok: true, value }
    : { ok: false, error: `${key} must be text up to ${max} characters.` };
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
): Result<boolean | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  return typeof raw === 'boolean'
    ? { ok: true, value: raw }
    : { ok: false, error: `${key} must be true or false.` };
}

function optionalAmount(source: Record<string, unknown>, key: string): Result<number | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000_000
    ? { ok: true, value: raw }
    : { ok: false, error: `${key} must be a number between 0 and 1000000000.` };
}

export function parseLeadApiPayload(input: unknown): Result<LeadApiPayload> {
  const source = record(input);
  if (!source) return { ok: false, error: 'The request body must be a JSON object.' };
  const name = cleanText(source.customer_name, 160);
  if (!name || name.length < 2)
    return { ok: false, error: 'customer_name is required (2 to 160 characters).' };
  const phone = typeof source.phone === 'string' ? normalizeWebsitePhone(source.phone) : null;
  if (!phone) return { ok: false, error: 'phone must be a valid mobile number.' };
  let email: string | undefined;
  if (typeof source.email === 'string' && source.email.trim()) {
    email = source.email.trim().toLowerCase();
    if (email.length > 254 || !emailPattern.test(email))
      return { ok: false, error: 'email is not a valid email address.' };
  }
  const texts = {
    interested_model: optionalText(source, 'interested_model', 160),
    campaign: optionalText(source, 'campaign', 200),
    source_detail: optionalText(source, 'source_detail', 200),
    branch_code: optionalText(source, 'branch_code', 40),
    external_lead_id: optionalText(source, 'external_lead_id', 200),
    city: optionalText(source, 'city', 120),
    message: optionalText(source, 'message', 1000),
  };
  for (const result of Object.values(texts)) if (!result.ok) return result;
  const rawRequirements = source.requirements === undefined ? {} : record(source.requirements);
  if (!rawRequirements) return { ok: false, error: 'requirements must be an object.' };
  const requirementChecks = {
    variant: optionalText(rawRequirements, 'variant', 120),
    fuel_type: optionalText(rawRequirements, 'fuel_type', 40),
    transmission: optionalText(rawRequirements, 'transmission', 40),
    purchase_timeline: optionalText(rawRequirements, 'purchase_timeline', 60),
    budget_min: optionalAmount(rawRequirements, 'budget_min'),
    budget_max: optionalAmount(rawRequirements, 'budget_max'),
    finance_required: optionalBoolean(rawRequirements, 'finance_required'),
    exchange_required: optionalBoolean(rawRequirements, 'exchange_required'),
    test_drive_required: optionalBoolean(rawRequirements, 'test_drive_required'),
  };
  const requirements: Record<string, unknown> = {};
  for (const [key, result] of Object.entries(requirementChecks)) {
    if (!result.ok) return { ok: false, error: `requirements.${result.error}` };
    if (result.value !== undefined) requirements[key] = result.value;
  }
  if (
    typeof requirements.budget_min === 'number' &&
    typeof requirements.budget_max === 'number' &&
    requirements.budget_max < requirements.budget_min
  )
    return { ok: false, error: 'requirements.budget_max must be at least budget_min.' };
  const value = (result: Result<string | undefined>) => (result.ok ? result.value : undefined);
  return {
    ok: true,
    value: {
      customer_name: name,
      phone,
      email,
      interested_model: value(texts.interested_model),
      campaign: value(texts.campaign),
      source_detail: value(texts.source_detail),
      branch_code: value(texts.branch_code),
      external_lead_id: value(texts.external_lead_id),
      city: value(texts.city),
      message: value(texts.message),
      requirements: requirements as WebsiteLeadRequirements,
    },
  };
}

// --- Embed snippet ----------------------------------------------------------------

export function websiteEmbedSnippet(crmBaseUrl: string, publicKey: string) {
  const base = crmBaseUrl.replace(/\/+$/, '');
  return `<script src="${base}/widget/v1/gdm-chat.js" data-key="${publicKey}" async></script>`;
}

export const WEBSITE_PUBLIC_KEY_PATTERN = /^wpk_[A-Za-z0-9_-]{24,64}$/;
export const LEAD_API_KEY_PATTERN = /^gdm_live_([A-Za-z0-9]{8,16})_([A-Za-z0-9_-]{32,64})$/;
