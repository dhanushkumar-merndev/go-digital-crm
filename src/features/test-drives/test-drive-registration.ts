export const TEST_DRIVE_REGISTRATION_MIN_LENGTH = 4;
export const TEST_DRIVE_REGISTRATION_MAX_LENGTH = 24;

const disallowedRegistrationCharacters = /[^A-Z0-9 -]/g;
const validRegistration = /^[A-Z0-9 -]{4,24}$/;

export function sanitizeTestDriveRegistrationInput(value: string) {
  return value
    .toUpperCase()
    .replace(disallowedRegistrationCharacters, '')
    .slice(0, TEST_DRIVE_REGISTRATION_MAX_LENGTH);
}

export function normalizeTestDriveRegistration(value: string) {
  return value.trim().toUpperCase();
}

export function isValidTestDriveRegistration(value: string) {
  return validRegistration.test(normalizeTestDriveRegistration(value));
}
