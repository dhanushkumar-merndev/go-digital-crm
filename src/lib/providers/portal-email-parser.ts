// Lead emails from Justdial, CarWale, CarDekho and IndiaMART, read from the
// dealership's own mailbox. The Client Admin names the portal's sender domain
// and, per CRM field, the label words that precede the value in the email
// ("Name", "Mobile No", ...). The same parser runs in the browser preview and
// in the Trigger.dev inbox worker, so a preview that extracts a field is the
// result the worker produces for that email.
//
// Deliberately import-free: the Edge Function imports this file from Deno by
// path, where only `.ts`-suffixed relative imports resolve.

export const portalInboxProviderKeys = ['justdial', 'carwale', 'cardekho', 'indiamart'] as const;
export type PortalInboxProviderKey = (typeof portalInboxProviderKeys)[number];

/** Canonical lead source per portal (AGENTS 9.2). */
export const portalLeadSource: Record<PortalInboxProviderKey, string> = {
  justdial: 'Justdial',
  carwale: 'CarWale',
  cardekho: 'CarDekho',
  indiamart: 'IndiaMART',
};

export const portalPollIntervals = [10, 20, 30] as const;
export type PortalPollInterval = (typeof portalPollIntervals)[number];

export const portalEmailFields = [
  'customer_name',
  'phone',
  'email',
  'location',
  'interested_model',
  'campaign',
  'message',
] as const;
export type PortalEmailField = (typeof portalEmailFields)[number];

export const portalEmailFieldLabels: Record<PortalEmailField, string> = {
  customer_name: 'Customer name',
  phone: 'Mobile',
  email: 'Email',
  location: 'Location / city',
  interested_model: 'Interested model',
  campaign: 'Campaign',
  message: 'Message',
};

/** Source (AGENTS 9.3): a lead needs a name and a phone, everything else is optional. */
export const portalRequiredFields: readonly PortalEmailField[] = ['customer_name', 'phone'];

export const portalCaptureModes = ['REST_OF_LINE', 'NEXT_WORD', 'NEXT_LINE'] as const;
export type PortalCaptureMode = (typeof portalCaptureModes)[number];

export const portalCaptureLabels: Record<PortalCaptureMode, string> = {
  REST_OF_LINE: 'Rest of the line',
  NEXT_WORD: 'Next word only',
  NEXT_LINE: 'Next line',
};

export type PortalEmailRule = {
  field: PortalEmailField;
  keywords: string[];
  capture: PortalCaptureMode;
};

export const PORTAL_MAX_KEYWORDS_PER_RULE = 10;
export const PORTAL_MAX_KEYWORD_LENGTH = 60;
export const PORTAL_MAX_SENDER_DOMAINS = 5;

const rule = (
  field: PortalEmailField,
  keywords: string[],
  capture: PortalCaptureMode = 'REST_OF_LINE',
): PortalEmailRule => ({ field, keywords, capture });

/**
 * Starting point only. Portals change their email layout without notice, so
 * every keyword is editable in the connection form and checked in its preview.
 * Longer labels come first: "Customer Name" must win over a bare "Name".
 * "Seller" is deliberately absent: on a listing enquiry the seller is the
 * dealer, so "Seller mobile" is not reliably the customer's number.
 */
const carPortalRules = [
  rule('customer_name', ['Customer Name', 'Buyer Name', 'Name', 'Customer', 'Buyer']),
  rule('phone', [
    'Customer Mobile',
    'Buyer Mobile',
    'Mobile Number',
    'Mobile No',
    'Mobile / Cell',
    'Mobile',
    'Phone Number',
    'Phone',
    'Contact Number',
    'Contact No',
  ]),
  rule('email', ['Contact Email', 'Email Address', 'Email ID', 'Email', 'E-mail']),
  rule('location', ['City', 'Location']),
  rule('interested_model', ['Car Name', 'Interested In', 'Model', 'Car']),
  rule('message', ['Customer Comments', 'Buyer Message', 'Comments', 'Message', 'Request']),
];

export const portalEmailPresets: Record<
  PortalInboxProviderKey,
  { senderDomains: string[]; rules: PortalEmailRule[] }
> = {
  justdial: {
    senderDomains: ['justdial.com'],
    rules: [
      rule('customer_name', ['Caller Name', 'Customer Name', 'Name', 'Customer', 'Caller']),
      rule('phone', [
        'Caller Number',
        'Mobile No',
        'Mobile Number',
        'Mobile / Cell',
        'Mobile',
        'Phone',
        'Contact No',
        'Contact Number',
      ]),
      rule('email', ['Contact Email', 'Email Address', 'Email ID', 'Email', 'E-mail']),
      rule('location', ['City', 'Location', 'Area']),
      rule('interested_model', [
        'Searched For',
        'Service Required',
        'Service',
        'Category',
        'Product',
      ]),
      rule('message', [
        'Customer Requirement',
        'Requirement',
        'Comments',
        'Message',
        'Query',
        'Request',
      ]),
    ],
  },
  carwale: { senderDomains: ['carwale.com'], rules: carPortalRules },
  cardekho: { senderDomains: ['cardekho.com'], rules: carPortalRules },
  indiamart: {
    senderDomains: ['indiamart.com'],
    rules: [
      rule('customer_name', ['Buyer Name', 'Contact Person', 'Name', 'Buyer', 'Caller']),
      rule('phone', [
        'Buyer Mobile',
        'Caller Number',
        'Mobile Number',
        'Mobile / Cell',
        'Mobile',
        'Phone',
        'Contact Number',
      ]),
      rule('email', ['Contact Email', 'Email Address', 'Email ID', 'Email', 'E-mail']),
      rule('location', ['City', 'Location', 'Address']),
      rule('interested_model', ['Looking for', 'Product', 'Requirement', 'Subject']),
      rule('message', [
        'Buyer Message',
        'Requirement Details',
        'Description',
        'Message',
        'Request',
      ]),
    ],
  },
};

const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * "customer@cardekho.com", "@cardekho.com" and "cardekho.com" all name the
 * sender domain cardekho.com. Returns null for anything that is not a domain.
 */
export function normalizeSenderDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const domain = (trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed)
    .replace(/^\.+|\.+$/g, '')
    .replace(/[>\s]/g, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/** The domain of an email address, lower-cased; null when it has none. */
export function senderDomainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  return normalizeSenderDomain(address.slice(at + 1));
}

/**
 * The sender belongs to a configured domain or one of its subdomains
 * (leads.cardekho.com matches cardekho.com). A lookalike such as
 * notcardekho.com does not.
 */
export function senderMatches(fromAddress: string, domains: readonly string[]): boolean {
  const domain = senderDomainOf(fromAddress);
  if (!domain) return false;
  return domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), match);
    if (lower.startsWith('#') && lower !== '#39')
      return safeCodePoint(Number.parseInt(lower.slice(1), 10), match);
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function safeCodePoint(code: number, fallback: string) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

/**
 * Lead emails are mostly HTML tables. Cells become " | "-separated and rows
 * become lines -- the same shape a table has when copied out of Gmail (tabs
 * are mapped to " | " in the parser), so a pasted preview and a fetched email
 * read identically.
 */
export function portalEmailHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // "Mobile: <a href="tel:+91...">Call customer</a>": the number lives
      // only in the link, so it is written out ahead of the link text.
      .replace(/<a\b[^>]*\bhref\s*=\s*["']\s*(?:tel|mailto):([^"'?]+)[^"']*["'][^>]*>/gi, ' $1 ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer|blockquote)\s*>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function textLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/\t+/g, ' | ')
        .replace(/[  ​]+/g, ' ')
        .replace(/(\s*\|\s*)+/g, ' | ')
        .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEPARATORS = /^[\s:：\-–—=|>.]+/;

// A label ends at a separator or the end of the line, so "Customer contact:
// hidden" and "Forwarded message" are not labels. A dash separates only when
// a space follows ("Car Name - Nexon", not "customer-facing"), and a full
// stop only before another separator ("Mobile No.:", not "Customer. Total").
const LABEL_END = String.raw`(?=\s*(?:[:：=|>]|[\-–—](?=\s)|\.(?=\s*(?:[:：=|>\-–—]|$))|$))`;

function keywordPattern(keyword: string, anchored: boolean) {
  const words = keyword.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  // Anchored: the label opens the line (after bullets or a table border).
  // Unanchored: the label sits anywhere, but on word boundaries.
  return new RegExp(
    anchored ? `^[\\s*•·\\-|>]*${words}${LABEL_END}` : `(?<![\\p{L}\\p{N}])${words}${LABEL_END}`,
    'iu',
  );
}

/**
 * Lead emails also carry the dealer's, the portal's and the forwarding
 * employee's contact details. A label preceded by one of these roles
 * ("Dealer mobile:", "Platform support email:") never fills a customer field.
 */
const NON_CUSTOMER_ROLE =
  /(?<![\p{L}\p{N}])(dealer|dealership|support|help\s*desk|helpdesk|platform|portal|recipient|account\s+manager|agent|executive|consultant|showroom|signature|not\s+(?:the\s+)?customer)(?![\p{L}\p{N}])/iu;

type KeywordHit = { lineIndex: number; remainder: string; anchored: boolean };

function findKeyword(lines: string[], keywords: readonly string[]): KeywordHit | null {
  // A label at the start of a line is far more reliable than the same word in
  // the middle of a sentence, so every keyword is tried anchored first.
  for (const anchored of [true, false]) {
    for (const keyword of keywords) {
      if (!keyword.trim()) continue;
      const pattern = keywordPattern(keyword, anchored);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const match = pattern.exec(lines[lineIndex]);
        if (!match) continue;
        if (!anchored && NON_CUSTOMER_ROLE.test(lines[lineIndex].slice(0, match.index))) continue;
        return {
          lineIndex,
          remainder: lines[lineIndex].slice(match.index + match[0].length),
          anchored,
        };
      }
    }
  }
  return null;
}

function cutAtNextLabel(value: string, otherKeywords: readonly string[]) {
  // "Name: Ravi Kumar  Mobile: 98..." on one line: stop before the next label
  // that is followed by a separator. A table cell boundary also ends a value.
  let end = value.search(/\s\|\s/);
  if (end < 0) end = value.length;
  for (const keyword of otherKeywords) {
    if (!keyword.trim()) continue;
    const words = keyword.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${words}\\s*[:：=]`, 'iu').exec(value);
    if (match && match.index > 0 && match.index < end) end = match.index;
  }
  return value.slice(0, end).trim();
}

function capture(
  lines: string[],
  hit: KeywordHit,
  mode: PortalCaptureMode,
  otherKeywords: readonly string[],
): string | undefined {
  const sameLine = cutAtNextLabel(hit.remainder.replace(SEPARATORS, ''), otherKeywords);
  const nextLine = lines[hit.lineIndex + 1]
    ? cutAtNextLabel(lines[hit.lineIndex + 1].replace(SEPARATORS, ''), otherKeywords)
    : '';
  if (mode === 'NEXT_LINE') return nextLine || undefined;
  // A label alone on its line ("Mobile" then the number below) falls through
  // to the next line, the common layout of two-column tables pasted as text.
  // A label met mid-line is not alone, so its next line belongs to something else.
  // "Buyer message:" ending its line is a heading for the text below, even
  // though the keyword "Message" sits mid-line.
  const labelEndsLine = /^\s*[:：]\s*$/.test(hit.remainder);
  const value = sameLine || (hit.anchored || labelEndsLine ? nextLine : '');
  if (!value) return undefined;
  if (mode === 'NEXT_WORD') return value.split(/\s+/)[0];
  return value;
}

/** Indian mobile normalisation shared with the portal webhook adapters. */
export function normalizePortalPhone(value: string): string | null {
  const candidate = /\+?\d[\d\s().-]{8,}\d/.exec(value)?.[0];
  if (!candidate) return null;
  const hasPlus = candidate.trim().startsWith('+');
  const digits = candidate.replace(/\D/g, '');
  if (hasPlus) return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  const stripped = digits.replace(/^0+/, '');
  if (stripped.length === 10) return `+91${stripped}`;
  if (stripped.length === 12 && stripped.startsWith('91')) return `+${stripped}`;
  return stripped.length >= 11 && stripped.length <= 15 ? `+${stripped}` : null;
}

const EMAIL_PATTERN = /[^\s@<>()[\]:;,|"']+@[^\s@<>()[\]:;,|"']+\.[a-z]{2,63}/i;

const FIELD_MAX_LENGTH: Record<PortalEmailField, number> = {
  customer_name: 120,
  phone: 20,
  email: 254,
  location: 200,
  interested_model: 160,
  campaign: 160,
  message: 1000,
};

/** "Not supplied", "N/A", "Hidden until unlocked": a label with no usable value. */
const PLACEHOLDER_VALUE =
  /^(?:not\s+(?:supplied|provided|available|shared|disclosed|given)|n\/?a|nil|none|null|unknown|-+|(?:hidden|withheld|masked|locked)\b.*)$/i;

function cleanField(field: PortalEmailField, raw: string): string | undefined {
  if (PLACEHOLDER_VALUE.test(raw.trim())) return undefined;
  if (field === 'phone') return normalizePortalPhone(raw) ?? undefined;
  if (field === 'email') return EMAIL_PATTERN.exec(raw)?.[0].toLowerCase();
  // A customer's message keeps its closing full stop; a name or city does not.
  const value = raw.replace(field === 'message' ? /[\s,;:|-]+$/ : /[\s,;:.|-]+$/, '').trim();
  return value ? value.slice(0, FIELD_MAX_LENGTH[field]) : undefined;
}

export type PortalEmailParseResult = {
  fields: Partial<Record<PortalEmailField, string>>;
  /** Required fields that were not found or did not validate. */
  missing: PortalEmailField[];
  ok: boolean;
};

export function parsePortalEmail(
  text: string,
  rules: readonly PortalEmailRule[],
): PortalEmailParseResult {
  return parseLines(textLines(text), rules);
}

/** A line that only divides records: "-----", "*** Next enquiry ***". */
const RECORD_DIVIDER =
  /^[\s\-=_*~|:#.]*(?:next\s+(?:lead|enquiry|inquiry|requirement)[\s\-=_*~|:#.]*)?$/i;

/**
 * Every lead in the email. A digest names several customers, each under the
 * customer-name label; reading it as one lead would pair the first
 * customer's name with a later customer's number, so each name starts its
 * own record. The record runs to the last divider line before the next name,
 * or to that name. Lines above the first name (subject, portal header) belong
 * to the first record only. One name, or the same name repeated, is one lead.
 */
export function parsePortalEmailLeads(
  text: string,
  rules: readonly PortalEmailRule[],
): PortalEmailParseResult[] {
  const lines = textLines(text);
  const nameRule = rules.find((item) => item.field === 'customer_name');
  const patterns = (nameRule?.keywords ?? [])
    .filter((keyword) => keyword.trim())
    .map((keyword) => keywordPattern(keyword, true));
  const starts: number[] = [];
  const names = new Set<string>();
  lines.forEach((line, index) => {
    const match = patterns.map((pattern) => pattern.exec(line)).find(Boolean);
    if (!match) return;
    const value = cleanField(
      'customer_name',
      line.slice(match.index + match[0].length).replace(SEPARATORS, ''),
    );
    if (!value) return;
    starts.push(index);
    names.add(value.toLowerCase());
  });
  if (starts.length < 2 || names.size < 2) return [parseLines(lines, rules)];

  const ends = starts.map((start, position) => {
    const next = starts[position + 1] ?? lines.length;
    for (let index = next - 1; index > start; index -= 1) {
      if (RECORD_DIVIDER.test(lines[index])) return index;
    }
    return next;
  });
  return starts.map((start, position) => {
    // A record opens after the previous one's divider, so a "Reference" line
    // printed above the customer's name stays with that customer.
    const from = position === 0 ? 0 : Math.min(start, ends[position - 1] + 1);
    return parseLines(lines.slice(from, ends[position]), rules);
  });
}

function parseLines(lines: string[], rules: readonly PortalEmailRule[]): PortalEmailParseResult {
  const allKeywords = rules.flatMap((item) => item.keywords);
  const fields: Partial<Record<PortalEmailField, string>> = {};
  for (const item of rules) {
    if (fields[item.field]) continue;
    const hit = findKeyword(lines, item.keywords);
    if (!hit) continue;
    const otherKeywords = allKeywords.filter((keyword) => !item.keywords.includes(keyword));
    const raw = capture(lines, hit, item.capture, otherKeywords);
    const value = raw ? cleanField(item.field, raw) : undefined;
    if (value) fields[item.field] = value;
  }
  const missing = portalRequiredFields.filter((field) => !fields[field]);
  return { fields, missing, ok: missing.length === 0 };
}

/** Mask a mailbox for display: le…@dealer.com. */
export function maskMailbox(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return 'Mailbox';
  const local = address.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}…${address.slice(at)}`;
}
