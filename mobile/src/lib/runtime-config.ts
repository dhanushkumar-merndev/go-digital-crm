export type MobileSupabaseConfiguration = {
  url?: string;
  anonKey?: string;
};

export function hasMobileSupabaseConfiguration(config: MobileSupabaseConfiguration) {
  const url = config.url?.trim() ?? '';
  const anonKey = config.anonKey?.trim() ?? '';
  return (
    /^https?:\/\/[^/]+/i.test(url) &&
    url !== 'https://not-configured.invalid' &&
    anonKey.length >= 20 &&
    anonKey !== 'not-configured'
  );
}

export const mobileSupabaseConfiguration = {
  url: process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '',
  anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '',
};

export const mobileSupabaseConfigured = hasMobileSupabaseConfiguration(mobileSupabaseConfiguration);
