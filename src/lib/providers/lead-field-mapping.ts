/** One saved rule: an ads account's own column name and the CRM field it fills. */
export type LeadFieldMappingRule = { external_field: string; canonical_field: string };

/** CRM fields an ad-form column can fill. Source, branch and the provider's own
 * lead ID come from the connection and the event itself, never from a form column. */
export const adMappableLeadFields = [
  'customerName',
  'phone',
  'email',
  'location',
  'campaign',
  'interestedModel',
  'sourceDetail',
] as const;
export type AdMappableLeadField = (typeof adMappableLeadFields)[number];

/**
 * Values picked out of a provider's columns by the saved rules. Column names
 * match case-insensitively because providers are inconsistent about case; a
 * rule wins over the adapter's built-in column guesses.
 */
export function mappedLeadValues(
  columns: ReadonlyMap<string, string>,
  rules: readonly LeadFieldMappingRule[] = [],
) {
  const values: Partial<Record<AdMappableLeadField, string>> = {};
  for (const rule of rules) {
    const field = rule.canonical_field as AdMappableLeadField;
    if (!adMappableLeadFields.includes(field) || values[field] !== undefined) continue;
    const column = rule.external_field.trim();
    const value =
      columns.get(column) ??
      columns.get(column.toLocaleLowerCase()) ??
      columns.get(column.toLocaleUpperCase());
    if (value) values[field] = value;
  }
  return values;
}
