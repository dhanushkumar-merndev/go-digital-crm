export function toWhatsAppClickToChatUrl(phone: string) {
  const digits = phone.replace(/\D/g, '');
  const internationalNumber =
    digits.length === 10
      ? `91${digits}`
      : digits.length === 11 && digits.startsWith('0')
        ? `91${digits.slice(1)}`
        : digits;

  return `https://wa.me/${internationalNumber}`;
}
