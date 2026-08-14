import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items) => {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data: userData } = await supabase.auth.getUser();
  const isPublic = request.nextUrl.pathname === '/login';
  if (!userData.user)
    return isPublic ? response : NextResponse.redirect(new URL('/login', request.url));
  const { data, error } = await supabase.rpc('get_access_context');
  if (error || !data) return NextResponse.redirect(new URL('/access/locked', request.url));
  const context = data as AccessContext;
  if (context.destination !== 'CRM') {
    const target = accessPaths[context.destination as keyof typeof accessPaths] ?? '/login';
    return request.nextUrl.pathname === target
      ? response
      : NextResponse.redirect(new URL(target, request.url));
  }
  if (isPublic || request.nextUrl.pathname.startsWith('/access/'))
    return NextResponse.redirect(
      new URL(`/${context.role_key ?? 'telecaller'}/dashboard`, request.url),
    );
  const requestedRole = request.nextUrl.pathname.split('/')[1];
  if (context.role_key && requestedRole !== context.role_key)
    return NextResponse.redirect(new URL(`/${context.role_key}/dashboard`, request.url));
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
