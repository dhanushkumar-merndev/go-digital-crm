import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase browser configuration is missing.');
  const options: Record<string, unknown> = {};

  if (process.env.NODE_ENV === 'development') {
    console.log('[Supabase Client] Dev Network Logger initialized');
    options.global = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const start = performance.now();
        const response = await fetch(input, init);
        const end = performance.now();
        const duration = (end - start).toFixed(2);
        const urlStr =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;

        console.log(`[DB/Network] 🟢 API DB fetch: ${urlStr.split('/').pop()} took ${duration}ms`);
        return response;
      },
    };
  }

  return createBrowserClient(url, key, options);
}

export function hasSupabaseConfig() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
