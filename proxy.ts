import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
  encodeWorkspaceBootstrapHeader,
  WORKSPACE_BOOTSTRAP_HEADER,
} from '@/lib/auth/workspace-bootstrap-header';
import { getRuntimeMode, isDevelopmentDemoRoleLoginEnabled } from '@/lib/runtime/runtime-mode';
import { DEVELOPMENT_DEMO_ROLE_LOGIN_PATH } from '@/lib/auth/development-demo-role-login';
import { isTransientSupabaseError } from '@/lib/supabase/transient-error';

type AccessContext = {
  destination:
    'CRM' | 'LOGIN' | 'ACCOUNT_LOCKED' | 'ONBOARDING' | 'MFA' | 'MAINTENANCE' | 'NO_ROLE';
  role_key?: string;
};
const accessDestinations = new Set<AccessContext['destination']>([
  'CRM',
  'LOGIN',
  'ACCOUNT_LOCKED',
  'ONBOARDING',
  'MFA',
  'MAINTENANCE',
  'NO_ROLE',
]);
const accessPaths: Record<Exclude<AccessContext['destination'], 'CRM' | 'LOGIN'>, string> = {
  ACCOUNT_LOCKED: '/access/locked',
  ONBOARDING: '/access/onboarding',
  MFA: '/access/mfa',
  MAINTENANCE: '/access/maintenance',
  NO_ROLE: '/access/no-role',
};

function isAccessContext(value: unknown): value is AccessContext {
  if (!value || typeof value !== 'object') return false;
  const destination = (value as Record<string, unknown>).destination;
  if (
    typeof destination !== 'string' ||
    !accessDestinations.has(destination as AccessContext['destination'])
  )
    return false;
  return destination !== 'CRM' || typeof (value as Record<string, unknown>).role_key === 'string';
}

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
  const pathname = request.nextUrl.pathname;
  if (runtimeMode === 'LOCAL_PREVIEW') return NextResponse.next({ request });
  if (isDevelopmentDemoRoleLoginEnabled() && pathname === DEVELOPMENT_DEMO_ROLE_LOGIN_PATH)
    return NextResponse.next({ request });

  if (runtimeMode === 'MISCONFIGURED') {
    return pathname === '/access/configuration'
      ? privateNoStore(NextResponse.next({ request }))
      : redirectWithSessionCookies('/access/configuration', request);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return redirectWithSessionCookies('/access/configuration', request);

  const upstreamHeaders = new Headers(request.headers);
  // Never trust a value supplied by the browser. Only the verified value set
  // below may be consumed by Server Components.
  upstreamHeaders.delete(WORKSPACE_BOOTSTRAP_HEADER);

  const nextResponse = () =>
    NextResponse.next({
      request: { headers: upstreamHeaders },
    });
  let response = nextResponse();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items, headers) => {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = nextResponse();
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const isPublicAuthPath = publicAuthPaths.has(pathname);
  if (claimsError || !claimsData?.claims?.sub) {
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

  let bootstrap = await supabase.rpc('get_workspace_bootstrap');
  if (isTransientSupabaseError(bootstrap.error))
    bootstrap = await supabase.rpc('get_workspace_bootstrap');
  if (bootstrap.error || !isAccessContext(bootstrap.data)) {
    console.error('WORKSPACE_BOOTSTRAP_UNAVAILABLE', {
      code: bootstrap.error?.code ?? (bootstrap.data ? 'INVALID_PAYLOAD' : 'NO_DATA'),
    });
    return pathname === '/access/unavailable'
      ? privateNoStore(response)
      : redirectWithSessionCookies('/access/unavailable', request, response);
  }
  const data = bootstrap.data;
  const context = data;
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

  const encodedBootstrap = encodeWorkspaceBootstrapHeader(data);
  if (encodedBootstrap) {
    const refreshedCookies = response.cookies.getAll();
    upstreamHeaders.set(WORKSPACE_BOOTSTRAP_HEADER, encodedBootstrap);
    response = nextResponse();
    refreshedCookies.forEach((cookie) => response.cookies.set(cookie));
  }

  return privateNoStore(response);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
