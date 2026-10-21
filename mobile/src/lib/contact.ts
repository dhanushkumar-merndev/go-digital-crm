import { Linking } from 'react-native';
import { forgetAccessContext } from '@/lib/access-context';
import { fetchMobileRole, recordMobileLeadContact, type MobileRole } from '@/lib/lead-detail';

export function dialablePhone(phone: string) {
  return phone.replace(/[^+\d]/g, '');
}

// wa.me needs the country code; a bare 10-digit number is an Indian mobile.
export function whatsappPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

export function openDialer(phone: string) {
  return Linking.openURL(`tel:${dialablePhone(phone)}`);
}

export function openWhatsApp(phone: string) {
  return Linking.openURL(`https://wa.me/${whatsappPhone(phone)}`);
}

let cachedRole: Promise<MobileRole> | undefined;

export function currentRole() {
  cachedRole ??= fetchMobileRole().catch((error) => {
    cachedRole = undefined;
    throw error;
  });
  return cachedRole;
}

export function resetRoleCache() {
  cachedRole = undefined;
  forgetAccessContext();
}

// Codes that mean "this call does not move the lead", not a failure: the
// lead is already with Sales or closed for this role.
const benignContactCodes = /LEAD_NOT_IN_INTAKE|SALES_HANDOFF_REQUIRED|LEAD_ALREADY_WITH_SALES/;

// Records the contact exactly as the web Call button does, so a phone call
// moves a New lead to Contacted.
export async function recordCallContact(leadId: string) {
  try {
    await recordMobileLeadContact(await currentRole(), leadId);
  } catch (error) {
    const text =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : '';
    if (!benignContactCodes.test(text)) throw error;
  }
}
