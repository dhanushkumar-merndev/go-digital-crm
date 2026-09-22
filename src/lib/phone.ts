/**
 * Customers give a mobile in whatever shape they have it: ten bare digits, a
 * leading trunk `0`, or the full `91…` international form. The CRM stores what
 * was typed -- `customers.primary_phone` is a matching signal, never an
 * identity -- so every place that dials, links or displays a number has to
 * agree on one interpretation of those shapes.
 *
 * India is the default country. A bare ten-digit number, or eleven digits
 * behind a trunk `0`, is Indian and gains `91` when it has to be dialled.
 * Anything already carrying another country code is left exactly as it is: the
 * seeded US numbers in this project would otherwise be rewritten into
 * plausible-looking Indian mobiles that ring a stranger.
 */
const DEFAULT_COUNTRY_CODE = '91';
const NATIONAL_NUMBER_LENGTH = 10;

export function phoneDigits(phone: string) {
  return phone.replace(/\D/g, '');
}

/**
 * The digits a provider should dial, country code included. Returns the digits
 * unchanged when the shape is not one this rule recognises, leaving the caller
 * or the provider to reject it rather than guessing.
 */
export function toDialableDigits(phone: string) {
  const digits = phoneDigits(phone);
  if (digits.length === NATIONAL_NUMBER_LENGTH) return `${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === NATIONAL_NUMBER_LENGTH + 1 && digits.startsWith('0'))
    return `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  return digits;
}

/** True when the number is Indian, in any of the three shapes above. */
function isDefaultCountryNumber(digits: string) {
  return (
    digits.length === NATIONAL_NUMBER_LENGTH ||
    (digits.length === NATIONAL_NUMBER_LENGTH + 1 && digits.startsWith('0')) ||
    (digits.length === DEFAULT_COUNTRY_CODE.length + NATIONAL_NUMBER_LENGTH &&
      digits.startsWith(DEFAULT_COUNTRY_CODE))
  );
}

/**
 * What a dense table column shows: the ten national digits for an Indian
 * number, so `919042606830`, `09042606830` and `9042606830` all read the same.
 * A foreign number keeps its full international form, because its last ten
 * digits alone would read as an Indian mobile and mean nothing to a user.
 */
export function formatNationalPhone(phone: string) {
  const digits = phoneDigits(phone);
  if (!digits) return phone;
  if (!isDefaultCountryNumber(digits)) return formatInternationalPhone(phone);
  return digits.slice(-NATIONAL_NUMBER_LENGTH);
}

/** The full number with its country code, for tooltips and detail screens. */
export function formatInternationalPhone(phone: string) {
  const digits = toDialableDigits(phone);
  return digits ? `+${digits}` : phone;
}

export function toWhatsAppClickToChatUrl(phone: string) {
  return `https://wa.me/${toDialableDigits(phone)}`;
}

export function toTelHref(phone: string) {
  return `tel:+${toDialableDigits(phone)}`;
}
