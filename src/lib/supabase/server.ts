import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase server configuration is missing.');
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          /* Server Components cannot write response cookies. */
        }
      },
    },
    ...(process.env.NODE_ENV === 'development' && {
      global: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const start = performance.now();
          const response = await fetch(input, init);
          const end = performance.now();
          const duration = (end - start).toFixed(2);
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
          console.log(`[SSR DB/Network] 🟢 API DB fetch: ${urlStr.split('/').pop()} took ${duration}ms`);
          return response;
        },
      },
    }),
  });
}
