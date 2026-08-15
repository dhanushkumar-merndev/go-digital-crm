import { type NextRequest, NextResponse } from 'next/server';
import {
  getPasswordRecoveryRedirectPath,
  PASSWORD_UPDATE_PATH,
} from '@/lib/auth/recovery-redirect';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function recoveryRedirect(request: NextRequest, path: string, invalid = false) {
  const target = new URL(path, request.url);
  if (invalid) target.searchParams.set('error', 'invalid_link');
  const response = NextResponse.redirect(target);
  response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  response.headers.set('Expires', '0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const flowId = request.nextUrl.searchParams.get('sb_flow_id');
  const nextPath = getPasswordRecoveryRedirectPath(request.nextUrl.searchParams.get('next'));
  if (!code) return recoveryRedirect(request, PASSWORD_UPDATE_PATH, true);

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (error) return recoveryRedirect(request, PASSWORD_UPDATE_PATH, true);
    return recoveryRedirect(request, nextPath);
  } catch {
    return recoveryRedirect(request, PASSWORD_UPDATE_PATH, true);
  }
}
