// Reads the phone number, call time and direction out of the file names that
// Android call recorders write. Pure: no React Native imports, so it is tested
// from tests/api.
//
// Seen in the wild:
//   Google Phone  Call recording +91 98765 43210_261018_143205.m4a
//   Samsung       Call recording 9876543210_261018_143205.m4a
//   Xiaomi        Ravi Kumar(9876543210)_20261018143205.mp3
//   OnePlus/Oppo  +919876543210_20261018143205.m4a
//   Others        incoming_9876543210_2026-10-18_14-32-05.m4a
//
// When the recorder saved a contact name instead of a number, phone is null and
// the user is asked to type it.

export type CallRecordingDirection = 'INBOUND' | 'OUTBOUND';

export type ParsedCallRecording = {
  phone: string | null;
  startedAt: Date | null;
  direction: CallRecordingDirection | null;
  contactName: string | null;
};

export const callRecordingExtensions = [
  'm4a',
  'mp3',
  'mp4',
  'aac',
  'amr',
  '3gp',
  'wav',
  'ogg',
  'opus',
  'webm',
];

// Formats the CRM accepts today; others are listed but cannot be uploaded.
export const uploadableCallRecordingExtensions = new Set([
  'm4a',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
]);

export function callRecordingExtension(fileName: string) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : '';
}

export function isCallRecordingFile(fileName: string) {
  return callRecordingExtensions.includes(callRecordingExtension(fileName));
}

// '+91 98765 43210', '09876543210', '919876543210', '9876543210' -> '+919876543210'.
// Mirrors app_private.recorded_call_phone on the server.
export function normalizeRecordedPhone(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (/^(91|0)?[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(-10)}`;
  if (trimmed.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

type TimestampMatch = { index: number; length: number; date: Date };

function validDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // Recorder names carry the phone's local time.
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

const timestampPatterns: Array<{ pattern: RegExp; read: (match: RegExpExecArray) => Date | null }> =
  [
    // 2026-10-18 14-32-05, 2026_10_18_14_32_05, 2026.10.18 14.32.05
    {
      pattern: /(20\d{2})[-_. ](\d{2})[-_. ](\d{2})[-_. T@]+(\d{2})[-_.:](\d{2})(?:[-_.:](\d{2}))?/,
      read: (m) => validDate(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)),
    },
    // 20261018143205, 20261018_143205, 20261018-1432
    {
      pattern: /(?<!\d)(20\d{2})(\d{2})(\d{2})[-_ ]?(\d{2})(\d{2})(\d{2})?(?!\d)/,
      read: (m) => validDate(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)),
    },
    // 261018_143205 (yyMMdd_HHmmss)
    {
      pattern: /(?<!\d)(\d{2})(\d{2})(\d{2})[-_ ](\d{2})(\d{2})(\d{2})(?!\d)/,
      read: (m) => validDate(2000 + +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]),
    },
  ];

function findTimestamp(name: string): TimestampMatch | null {
  for (const { pattern, read } of timestampPatterns) {
    const match = pattern.exec(name);
    if (!match) continue;
    const date = read(match);
    if (date) return { index: match.index, length: match[0].length, date };
  }
  return null;
}

function findPhone(name: string) {
  // A number in brackets is the recorder's "contact (number)" form; prefer it.
  const bracketed = /\(([+\d][\d\s-]{6,18}\d)\)/.exec(name);
  if (bracketed) {
    const phone = normalizeRecordedPhone(bracketed[1]);
    if (phone) return { phone, index: bracketed.index, length: bracketed[0].length };
  }
  const candidates = name.matchAll(/\+?\d[\d -]{6,18}\d/g);
  for (const candidate of candidates) {
    const phone = normalizeRecordedPhone(candidate[0]);
    if (phone) return { phone, index: candidate.index ?? 0, length: candidate[0].length };
  }
  return null;
}

function directionOf(name: string): CallRecordingDirection | null {
  if (/(^|[^a-z])(incoming|inbound|received)([^a-z]|$)/i.test(name)) return 'INBOUND';
  if (/(^|[^a-z])(outgoing|outbound|dialled|dialed)([^a-z]|$)/i.test(name)) return 'OUTBOUND';
  if (/(^|[_\s-])in([_\s-])/i.test(name)) return 'INBOUND';
  if (/(^|[_\s-])out([_\s-])/i.test(name)) return 'OUTBOUND';
  return null;
}

function cut(value: string, index: number, length: number) {
  return `${value.slice(0, index)} ${value.slice(index + length)}`;
}

export function parseCallRecordingFileName(fileName: string): ParsedCallRecording {
  const base = fileName
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.[a-z0-9]{2,5}$/i, '');
  let rest = base;

  const timestamp = findTimestamp(rest);
  if (timestamp) rest = cut(rest, timestamp.index, timestamp.length);

  const phone = findPhone(rest);
  if (phone) rest = cut(rest, phone.index, phone.length);

  const direction = directionOf(base);
  const contactName =
    rest
      .replace(/call[\s_-]*recording/gi, ' ')
      .replace(/\b(incoming|outgoing|inbound|outbound|received|dialled|dialed|in|out)\b/gi, ' ')
      .replace(/[()[\]_+@-]/g, ' ')
      .replace(/\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null;

  return {
    phone: phone?.phone ?? null,
    startedAt: timestamp?.date ?? null,
    direction,
    contactName,
  };
}
