// TeleCMI's Speech IVR feature delivers a call transcript (and possibly a
// summary), but the payload is undocumented. This adapter keeps that guesswork
// out of the webhook: it accepts the shapes a speech provider commonly sends and
// reports the names (never the values) of fields it does not recognise, so the
// first real delivery tells us where the text actually lives.

export type SpeechTurn = { speaker: 'AGENT' | 'CUSTOMER' | 'UNKNOWN'; text: string };
export type TelecmiSpeech = {
  transcript: string | null;
  turns: SpeechTurn[];
  summary: string | null;
  language: string | null;
};
export type PayloadField = { key: string; type: string; size: number | null };

const TRANSCRIPT_KEYS = [
  'transcript',
  'transcription',
  'transcripts',
  'speech_text',
  'speech_transcript',
  'speech',
  'stt',
  'stt_text',
];
// Too generic for a CDR's top level; trusted only inside a speech container.
const CONTAINER_ONLY_TRANSCRIPT_KEYS = ['text', 'content', 'conversation'];
const SUMMARY_KEYS = [
  'summary',
  'call_summary',
  'ai_summary',
  'speech_summary',
  'conversation_summary',
];
const LANGUAGE_KEYS = ['language', 'lang', 'language_code', 'locale'];
const CONTAINER_KEYS = [
  'speech_ivr',
  'speechivr',
  'speech',
  'ai',
  'analysis',
  'stt',
  'data',
  'result',
];

const MAX_TRANSCRIPT = 1_000_000;
const MAX_SUMMARY = 20_000;
const MAX_TURN = 12_000;
const MAX_TURNS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function list(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cleanText(value: unknown, maximum: number) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, maximum) : null;
}

// Leg a is the dealership agent on a click2call, leg b the customer. Stereo
// channels follow TeleCMI streaming: left (0) caller, right (1) callee.
function speakerOf(entry: Record<string, unknown>): SpeechTurn['speaker'] {
  const raw = String(
    entry.speaker ?? entry.role ?? entry.party ?? entry.leg ?? entry.channel ?? entry.user ?? '',
  )
    .trim()
    .toLowerCase();
  if (['agent', 'user', 'a', 'caller', 'left', '0', 'speaker_0', 'spk_0', 'agent_1'].includes(raw))
    return 'AGENT';
  if (
    [
      'customer',
      'b',
      'callee',
      'client',
      'right',
      '1',
      'speaker_1',
      'spk_1',
      'customer_1',
    ].includes(raw)
  )
    return 'CUSTOMER';
  return 'UNKNOWN';
}

function turnsFrom(value: unknown): SpeechTurn[] {
  const entries = list(value);
  if (!entries) return [];
  const turns: SpeechTurn[] = [];
  for (const entry of entries.slice(0, MAX_TURNS)) {
    const item = record(entry);
    const text = item
      ? cleanText(
          item.text ?? item.transcript ?? item.message ?? item.content ?? item.utterance,
          MAX_TURN,
        )
      : cleanText(entry, MAX_TURN);
    if (!text) continue;
    turns.push({ speaker: item ? speakerOf(item) : 'UNKNOWN', text });
  }
  return turns;
}

function scan(source: Record<string, unknown>, result: TelecmiSpeech, inContainer: boolean) {
  const transcriptKeys = inContainer
    ? [...TRANSCRIPT_KEYS, ...CONTAINER_ONLY_TRANSCRIPT_KEYS]
    : TRANSCRIPT_KEYS;
  for (const key of transcriptKeys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (!result.turns.length) {
      const turns = turnsFrom(value);
      if (turns.length) result.turns = turns;
    }
    if (!result.transcript) result.transcript = cleanText(value, MAX_TRANSCRIPT);
    // A transcript object can nest its own text, segments and summary.
    const nested = record(value);
    if (nested) scan(nested, result, true);
  }
  for (const key of ['segments', 'utterances', 'turns', 'dialogue', 'messages']) {
    if (!result.turns.length && source[key] !== undefined) result.turns = turnsFrom(source[key]);
  }
  for (const key of SUMMARY_KEYS) {
    if (!result.summary) {
      const value = source[key];
      const nested = record(value);
      result.summary = nested
        ? cleanText(nested.text ?? nested.summary ?? nested.content, MAX_SUMMARY)
        : cleanText(value, MAX_SUMMARY);
    }
  }
  for (const key of LANGUAGE_KEYS) {
    if (!result.language) result.language = cleanText(source[key], 40);
  }
}

/** Finds Speech IVR text at the top level or one container deep. Returns null
 * when the payload carries no transcript, turns or summary. */
export function extractTelecmiSpeech(payload: Record<string, unknown>): TelecmiSpeech | null {
  const result: TelecmiSpeech = { transcript: null, turns: [], summary: null, language: null };
  scan(payload, result, false);
  for (const key of CONTAINER_KEYS) {
    const container = record(payload[key]);
    if (container) scan(container, result, true);
  }
  if (!result.transcript && !result.turns.length && !result.summary) return null;
  return result;
}

function describe(value: unknown): Omit<PayloadField, 'key'> {
  if (value === null || value === undefined) return { type: 'null', size: null };
  if (Array.isArray(value)) return { type: 'array', size: value.length };
  if (typeof value === 'string') return { type: 'string', size: value.length };
  if (typeof value === 'object') return { type: 'object', size: Object.keys(value).length };
  return { type: typeof value, size: null };
}

/** Field names, types and sizes the webhook does not already read. Values are
 * never included: a transcript is customer speech and stays out of logs. */
export function unrecognisedPayloadFields(
  payload: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  limit = 60,
): PayloadField[] {
  const fields: PayloadField[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (fields.length >= limit) break;
    if (knownKeys.has(key)) continue;
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
    fields.push({ key: safeKey, ...describe(value) });
    const nested = record(value);
    if (!nested) continue;
    for (const [childKey, childValue] of Object.entries(nested)) {
      if (fields.length >= limit) break;
      fields.push({
        key: `${safeKey}.${childKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)}`,
        ...describe(childValue),
      });
    }
  }
  return fields;
}
