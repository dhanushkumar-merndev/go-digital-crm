import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isRoleKey } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  developmentDemoRoleEmails,
  DEVELOPMENT_DEMO_ROLE_LOGIN_PATH,
} from '@/lib/auth/development-demo-role-login';
import { isDevelopmentDemoRoleLoginEnabled } from '@/lib/runtime/runtime-mode';

export const dynamic = 'force-dynamic';

const requestSchema = z.object({ role: z.string().refine(isRoleKey) });

function privateJson(body: object, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  response.headers.set('Expires', '0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export async function POST(request: NextRequest) {
  if (!isDevelopmentDemoRoleLoginEnabled()) return privateJson({ error: 'NOT_FOUND' }, 404);

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return privateJson({ error: 'INVALID_ROLE' }, 422);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const password = process.env.DEMO_TEST_PASSWORD;
  if (!url || !key || !password) return privateJson({ error: 'DEMO_LOGIN_UNAVAILABLE' }, 503);

  const response = privateJson({ ok: true });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });
  const role = parsed.data.role as RoleKey;
  const { error } = await supabase.auth.signInWithPassword({
    email: developmentDemoRoleEmails[role],
    password,
  });
  if (error) return privateJson({ error: 'DEMO_LOGIN_REJECTED' }, 401);

  return response;
}

export function GET() {
  return privateJson({ error: 'METHOD_NOT_ALLOWED', path: DEVELOPMENT_DEMO_ROLE_LOGIN_PATH }, 405);
}
