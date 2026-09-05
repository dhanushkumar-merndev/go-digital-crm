export const LEAD_BULK_IMPORT_MAX_ROWS = 250;
export const LEAD_BULK_IMPORT_MAX_BYTES = 1024 * 1024;

export const leadBulkImportColumns = [
  'customer_name',
  'phone',
  'email',
  'source',
  'source_detail',
  'campaign',
  'interested_model',
] as const;

const requiredColumns = new Set(['customer_name', 'phone', 'source']);
const validSources = new Set([
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
]);

export type LeadBulkImportRow = Record<(typeof leadBulkImportColumns)[number], string>;

export type LeadBulkImportPreviewRow = {
  rowNumber: number;
  values: LeadBulkImportRow;
  errors: string[];
};

export type LeadBulkImportPreview = {
  rows: LeadBulkImportPreviewRow[];
  errors: string[];
};

export const leadBulkImportTemplate = `${leadBulkImportColumns.join(',')}\r\n`;

function parseCsvRecords(input: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('A quoted CSV value is not closed.');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, '_');
}

function validateRow(values: LeadBulkImportRow) {
  const errors: string[] = [];
  const name = values.customer_name.trim();
  const phone = values.phone.replace(/[^0-9+]/g, '');
  const email = values.email.trim();
  if (name.length < 2 || name.length > 160) errors.push('Customer name must be 2–160 characters.');
  if (values.phone.length > 24 || !/^\+?[0-9]{7,15}$/.test(phone))
    errors.push('Phone must contain 7–15 digits.');
  if (email && (email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))
    errors.push('Email is invalid.');
  if (!validSources.has(values.source.trim()))
    errors.push('Source is not one of the template values.');
  if (values.source_detail.length > 200)
    errors.push('Source detail is longer than 200 characters.');
  if (values.campaign.length > 200) errors.push('Campaign is longer than 200 characters.');
  if (values.interested_model.length > 160)
    errors.push('Interested model is longer than 160 characters.');
  return errors;
}

export function parseLeadBulkImportCsv(text: string): LeadBulkImportPreview {
  if (new TextEncoder().encode(text).byteLength > LEAD_BULK_IMPORT_MAX_BYTES)
    return { rows: [], errors: ['CSV must be 1 MB or smaller.'] };
  if (text.includes('\0'))
    return { rows: [], errors: ['CSV contains invalid control characters.'] };

  let records: string[][];
  try {
    records = parseCsvRecords(text);
  } catch (error) {
    return {
      rows: [],
      errors: [error instanceof Error ? error.message : 'CSV could not be read.'],
    };
  }
  while (records.at(-1)?.every((value) => value.trim() === '')) records.pop();
  if (records.length === 0) return { rows: [], errors: ['CSV is empty.'] };

  const headers = records[0].map(normalizeHeader);
  const errors: string[] = [];
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length) errors.push(`Duplicate column: ${[...new Set(duplicates)].join(', ')}.`);
  const unknown = headers.filter(
    (header) => !leadBulkImportColumns.includes(header as (typeof leadBulkImportColumns)[number]),
  );
  if (unknown.length) errors.push(`Unknown column: ${[...new Set(unknown)].join(', ')}.`);
  const missing = [...requiredColumns].filter((column) => !headers.includes(column));
  if (missing.length) errors.push(`Missing required column: ${missing.join(', ')}.`);
  if (errors.length) return { rows: [], errors };

  const dataRecords = records.slice(1).filter((row) => row.some((value) => value.trim() !== ''));
  if (dataRecords.length === 0) errors.push('Add at least one lead below the header row.');
  if (dataRecords.length > LEAD_BULK_IMPORT_MAX_ROWS)
    errors.push(`A single import can contain at most ${LEAD_BULK_IMPORT_MAX_ROWS} leads.`);

  const seen = new Map<string, number>();
  const rows = dataRecords.slice(0, LEAD_BULK_IMPORT_MAX_ROWS).map((record, index) => {
    const values = Object.fromEntries(
      leadBulkImportColumns.map((column) => {
        const columnIndex = headers.indexOf(column);
        return [column, columnIndex >= 0 ? (record[columnIndex] ?? '').trim() : ''];
      }),
    ) as LeadBulkImportRow;
    const rowErrors = validateRow(values);
    if (
      record.length > headers.length &&
      record.slice(headers.length).some((value) => value.trim())
    )
      rowErrors.push('Row has more values than the header.');
    const fingerprint = leadBulkImportColumns
      .map((column) => values[column].trim().toLocaleLowerCase())
      .join('\u001f');
    const duplicateOf = seen.get(fingerprint);
    if (duplicateOf) rowErrors.push(`Exact duplicate of row ${duplicateOf}.`);
    else seen.set(fingerprint, index + 2);
    return { rowNumber: index + 2, values, errors: rowErrors };
  });

  return { rows, errors };
}
