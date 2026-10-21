// Groq chat completions (OpenAI-compatible): translation to English, then the
// call summary and CRM field suggestions. Suggestions are never applied here;
// a person reviews them first (AGENTS.md §19).

const completionsUrl = 'https://api.groq.com/openai/v1/chat/completions';

type FetchLike = typeof fetch;

export type SpeakerRole = 'AGENT' | 'CUSTOMER' | 'UNKNOWN';

export type SourceTurn = { speakerId: string; text: string };

export type TranslatedTurns = {
  english: string[];
  roles: Record<string, SpeakerRole>;
};

// Bounded so a long call is translated in pieces that fit one response.
const translationChunkCharacters = 6_000;

function failureCode(status: number) {
  if (status === 401 || status === 403) return 'GROQ_AUTH_FAILED';
  if (status === 429) return 'GROQ_RATE_LIMITED';
  if (status >= 500) return 'GROQ_UNAVAILABLE';
  return 'GROQ_REQUEST_FAILED';
}

async function completeJson(input: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  fetchImpl: FetchLike;
}) {
  const response = await input.fetchImpl(completionsUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(failureCode(response.status));
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('GROQ_MALFORMED_RESPONSE');
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('GROQ_MALFORMED_RESPONSE');
  }
}

export function translationChunks(turns: SourceTurn[]) {
  const chunks: Array<{ offset: number; turns: SourceTurn[] }> = [];
  let current: SourceTurn[] = [];
  let offset = 0;
  let size = 0;
  turns.forEach((turn, index) => {
    if (current.length && size + turn.text.length > translationChunkCharacters) {
      chunks.push({ offset, turns: current });
      current = [];
      offset = index;
      size = 0;
    }
    current.push(turn);
    size += turn.text.length;
  });
  if (current.length) chunks.push({ offset, turns: current });
  return chunks;
}

const translationPrompt =
  'You translate an automobile dealership phone call into English. The turns come from speaker ' +
  'separation; speaker_id is the voice, not the role. Translate each turn faithfully into natural ' +
  'English (keep names, car models, prices and numbers exactly; if a turn is already English, ' +
  'return it unchanged). Decide which speaker_id is the dealership AGENT (greets for the ' +
  'showroom, offers models, prices or test drives) and which is the CUSTOMER; use UNKNOWN when ' +
  'it is not clear. Return JSON only: {"turns":[{"id":number,"english":string}],' +
  '"roles":{"<speaker_id>":"AGENT"|"CUSTOMER"|"UNKNOWN"}} with one entry per input id.';

/** English for every turn, in order, and the role of each Sarvam speaker id. */
export async function translateCallTurns(input: {
  apiKey: string;
  model: string;
  languageCode: string | null;
  turns: SourceTurn[];
  fetchImpl?: FetchLike;
}): Promise<TranslatedTurns> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const english = input.turns.map((turn) => turn.text);
  const roles: Record<string, SpeakerRole> = {};
  for (const chunk of translationChunks(input.turns)) {
    const parsed = await completeJson({
      apiKey: input.apiKey,
      model: input.model,
      fetchImpl,
      system: translationPrompt,
      user: JSON.stringify({
        language: input.languageCode ?? 'unknown',
        turns: chunk.turns.map((turn, index) => ({
          id: index,
          speaker_id: turn.speakerId,
          text: turn.text,
        })),
      }),
    });
    const translated = Array.isArray(parsed.turns) ? parsed.turns : [];
    for (const item of translated) {
      if (!item || typeof item !== 'object') continue;
      const { id, english: text } = item as { id?: unknown; english?: unknown };
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= chunk.turns.length)
        continue;
      if (typeof text === 'string' && text.trim())
        english[chunk.offset + id] = text.trim().slice(0, 12_000);
    }
    const chunkRoles =
      parsed.roles && typeof parsed.roles === 'object' && !Array.isArray(parsed.roles)
        ? (parsed.roles as Record<string, unknown>)
        : {};
    for (const [speakerId, role] of Object.entries(chunkRoles)) {
      // The first confident answer wins; a later chunk cannot swap the roles.
      if ((role === 'AGENT' || role === 'CUSTOMER') && !roles[speakerId]) roles[speakerId] = role;
    }
  }
  return { english, roles };
}

export type CallAnalysis = { summary: string; fields: Record<string, unknown> };

const analysisPrompt =
  'You review an English automobile dealership call transcript with AGENT and CUSTOMER lines. ' +
  'Return JSON only: {"summary":string,"fields":object}. The summary is a short factual recap ' +
  '(what the customer wants, budget, timeline, objections, agreed next step). fields may include ' +
  'customer_name, phone, email, interested_model, variant, budget_max, purchase_timeline, ' +
  'finance_required, exchange_required, test_drive_required, competitors, lifecycle_status, ' +
  'temperature, next_followup_at and lost_reason only when the call directly supports them. ' +
  'budget_max is the top of the stated budget as a number of rupees (15 lakh = 1500000). ' +
  'purchase_timeline is short text such as "This month" or "Within 3 months". ' +
  'finance_required, exchange_required and test_drive_required are true or false. ' +
  'competitors is an array of other brands or models the customer is considering. ' +
  'temperature is HOT (ready to buy, intent confirmed), WARM (interested, not committed) or ' +
  'COLD (little engagement). Only suggest lost_reason when the customer clearly gives a reason ' +
  'and lifecycle_status is Lost. next_followup_at is the agreed next contact or visit as ISO ' +
  '8601 with the offset of the call time given in the user message, or null; resolve relative ' +
  'days such as "this Saturday" from that call time. Preserve uncertain wording rather than ' +
  'inventing details. All fields are suggestions requiring human approval.';

// Dealerships are in India; the CRM's date-range RPCs default to the same zone.
const callTimeZone = 'Asia/Kolkata';
const callTimeFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: callTimeZone,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const lifecycleStatuses = [
  'New',
  'Contacted',
  'Qualified',
  'Appointment Scheduled',
  'Transferred to Sales',
  'Lost',
];

/** Summary and validated suggestions; unknown or malformed fields are dropped. */
export async function analyzeCall(input: {
  apiKey: string;
  model: string;
  transcript: string;
  /** When the call happened, so "this Saturday" becomes a date. */
  callStartedAt?: string | null;
  fetchImpl?: FetchLike;
}): Promise<CallAnalysis> {
  const startedAt = input.callStartedAt ? new Date(input.callStartedAt) : null;
  const callTime =
    startedAt && Number.isFinite(startedAt.getTime())
      ? `Call time: ${callTimeFormat.format(startedAt)} (India, UTC+05:30)\n\n`
      : '';
  const parsed = await completeJson({
    apiKey: input.apiKey,
    model: input.model,
    fetchImpl: input.fetchImpl ?? fetch,
    system: analysisPrompt,
    user: callTime + input.transcript.slice(0, 100_000),
  });
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 12_000) : '';
  const candidate =
    parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
      ? (parsed.fields as Record<string, unknown>)
      : {};
  const fields: Record<string, unknown> = {};
  const boundedText = new Map([
    ['customer_name', 200],
    ['phone', 40],
    ['email', 320],
    ['interested_model', 200],
    ['lost_reason', 500],
    // Lengths match the lead_requirements check constraint.
    ['variant', 120],
    ['purchase_timeline', 60],
  ]);
  for (const [key, maximum] of boundedText) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim()) fields[key] = value.trim().slice(0, maximum);
  }
  const budget = Number(candidate.budget_max);
  if (candidate.budget_max !== null && Number.isFinite(budget) && budget > 0 && budget <= 1e9)
    fields.budget_max = Math.round(budget);
  for (const key of ['finance_required', 'exchange_required', 'test_drive_required']) {
    if (typeof candidate[key] === 'boolean') fields[key] = candidate[key];
  }
  if (Array.isArray(candidate.competitors)) {
    const competitors = candidate.competitors
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 80))
      .slice(0, 12);
    if (competitors.length) fields.competitors = competitors;
  }
  if (
    typeof candidate.lifecycle_status === 'string' &&
    lifecycleStatuses.includes(candidate.lifecycle_status)
  )
    fields.lifecycle_status = candidate.lifecycle_status;
  const temperature =
    typeof candidate.temperature === 'string' ? candidate.temperature.toUpperCase() : '';
  if (['HOT', 'WARM', 'COLD', 'DORMANT'].includes(temperature)) fields.temperature = temperature;
  if (
    typeof candidate.next_followup_at === 'string' &&
    Number.isFinite(Date.parse(candidate.next_followup_at))
  )
    fields.next_followup_at = new Date(candidate.next_followup_at).toISOString();
  if (fields.lost_reason && fields.lifecycle_status !== 'Lost') delete fields.lost_reason;
  return { summary, fields };
}
