// Sarvam reports the spoken language as a BCP-47 code such as `ta-IN`.
const names: Record<string, string> = {
  as: 'Assamese',
  bn: 'Bengali',
  en: 'English',
  gu: 'Gujarati',
  hi: 'Hindi',
  kn: 'Kannada',
  ml: 'Malayalam',
  mr: 'Marathi',
  od: 'Odia',
  or: 'Odia',
  pa: 'Punjabi',
  ta: 'Tamil',
  te: 'Telugu',
  ur: 'Urdu',
};

export function spokenLanguageName(code: string | null | undefined) {
  if (!code) return 'the spoken language';
  return names[code.split('-')[0].toLowerCase()] ?? code;
}
