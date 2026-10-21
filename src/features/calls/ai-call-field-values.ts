// Labels and value conversion for AI call suggestions. Requirement fields are
// stored as booleans, numbers and lists, so an edited value is converted back
// from the text box before it is sent to review_ai_call_fields.

const fieldLabels: Record<string, string> = {
  customer_name: 'Customer name',
  phone: 'Phone',
  email: 'Email',
  interested_model: 'Interested model',
  lifecycle_status: 'Lead stage',
  temperature: 'Temperature',
  next_followup_at: 'Next follow-up',
  lost_reason: 'Lost reason',
  variant: 'Variant',
  budget_max: 'Budget',
  purchase_timeline: 'Buying timeline',
  finance_required: 'Needs finance',
  exchange_required: 'Has exchange',
  test_drive_required: 'Wants test drive',
  competitors: 'Also considering',
};

const yesNoFields = new Set(['finance_required', 'exchange_required', 'test_drive_required']);

export function aiFieldLabel(key: string) {
  return (
    fieldLabels[key] ?? key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function aiFieldDisplay(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ') || 'Not set';
  if (key === 'budget_max' && Number.isFinite(Number(value)))
    return `₹${Number(value).toLocaleString('en-IN')}`;
  if (key === 'next_followup_at' && typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()))
      return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export function aiFieldEditText(key: string, value: unknown) {
  if (value === null || value === undefined) return '';
  if (yesNoFields.has(key)) return value === true ? 'Yes' : value === false ? 'No' : String(value);
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function aiFieldEditValue(key: string, text: string): unknown {
  const trimmed = text.trim();
  if (yesNoFields.has(key)) return /^(y|yes|true)$/i.test(trimmed);
  if (key === 'budget_max') {
    const lakh = /^([\d.]+)\s*(l|lakh|lakhs)$/i.exec(trimmed);
    if (lakh) return Math.round(Number(lakh[1]) * 100_000);
    const digits = Number(trimmed.replace(/[₹,\s]/g, ''));
    return Number.isFinite(digits) && digits > 0 ? Math.round(digits) : null;
  }
  if (key === 'competitors')
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return trimmed;
}
