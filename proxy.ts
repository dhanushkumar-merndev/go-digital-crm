import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeMode } from '@/lib/runtime/runtime-mode';

type AccessContext = {
  destination:
    'CRM' | 'LOGIN' | 'ACCOUNT_LOCKED' | 'ONBOARDING' | 'MFA' | 'MAINTENANCE' | 'NO_ROLE';
  role_key?: string;
};
const accessPaths: Record<Exclude<AccessContext['destination'], 'CRM' | 'LOGIN'>, string> = {
  ACCOUNT_LOCKED: '/access/locked',
  ONBOARDING: '/access/onboarding',
  MFA: '/access/mfa',
  MAINTENANCE: '/access/maintenance',
  NO_ROLE: '/access/no-role',
};

const publicAuthPaths = new Set([
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  '/auth/invite',
]);

function privateNoStore(response: NextResponse) {
  response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  response.headers.set('Expires', '0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

function redirectWithSessionCookies(
  path: string,
  request: NextRequest,
  sessionResponse?: NextResponse,
) {
  const redirect = NextResponse.redirect(new URL(path, request.url));
  sessionResponse?.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return privateNoStore(redirect);
}

export async function proxy(request: NextRequest) {
  const runtimeMode = getRuntimeMode();
  if (runtimeMode === 'LOCAL_PREVIEW') return NextResponse.next({ request });

  const pathname = request.nextUrl.pathname;
  if (runtimeMode === 'MISCONFIGURED') {
    return pathname === '/access/configuration'
      ? privateNoStore(NextResponse.next({ request }))
      : redirectWithSessionCookies('/access/configuration', request);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return redirectWithSessionCookies('/access/configuration', request);

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items, headers) => {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });
  const { data: userData } = await supabase.auth.getUser();
  const isPublicAuthPath = publicAuthPaths.has(pathname);
  if (!userData.user) {
    return isPublicAuthPath
      ? privateNoStore(response)
      : redirectWithSessionCookies('/login', request, response);
  }

  if (
    pathname === '/auth/callback' ||
    pathname === '/auth/invite' ||
    pathname === '/reset-password'
  ) {
    return privateNoStore(response);
  }

  const { data, error } = await supabase.rpc('get_access_context');
  if (error || !data) return redirectWithSessionCookies('/access/locked', request, response);
  const context = data as AccessContext;
  if (context.destination !== 'CRM') {
    const target = accessPaths[context.destination as keyof typeof accessPaths] ?? '/login';
    return pathname === target
      ? privateNoStore(response)
      : redirectWithSessionCookies(target, request, response);
  }

  if (!context.role_key) return redirectWithSessionCookies('/access/no-role', request, response);

  const roleDashboard = `/${context.role_key}/dashboard`;
  if (isPublicAuthPath || pathname.startsWith('/access/')) {
    return redirectWithSessionCookies(roleDashboard, request, response);
  }

  const requestedRole = pathname.split('/')[1];
  if (requestedRole !== context.role_key) {
    return redirectWithSessionCookies(roleDashboard, request, response);
  }

  return privateNoStore(response);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
