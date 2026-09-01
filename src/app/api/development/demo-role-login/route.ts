import { createHmac } from 'node:crypto';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isRoleKey } from '@/config/navigation';
import type { RoleKey } from '@/config/navigation/types';
import {
  developmentDemoRoleEmails,
  developmentDemoMfaRoles,
  DEVELOPMENT_DEMO_ROLE_LOGIN_PATH,
} from '@/lib/auth/development-demo-role-login';
import { isDevelopmentDemoRoleLoginEnabled } from '@/lib/runtime/runtime-mode';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestSchema = z.object({ role: z.string().refine(isRoleKey) });

function privateJson(body: object, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  response.headers.set('Expires', '0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

function decodeBase32(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const character of secret.toUpperCase().replace(/=+$/g, '')) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('DEMO_MFA_SECRET_INVALID');
    buffer = (buffer << 5) | value;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >>> bitCount) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

function currentTotp(secret: string) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export async function POST(request: NextRequest) {
  if (!isDevelopmentDemoRoleLoginEnabled()) return privateJson({ error: 'NOT_FOUND' }, 404);

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return privateJson({ error: 'INVALID_ROLE' }, 422);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = process.env.DEMO_TEST_PASSWORD;
  if (!url || !key || !password) return privateJson({ error: 'DEMO_LOGIN_UNAVAILABLE' }, 503);

  const role = parsed.data.role as RoleKey;
  const demoEmail = developmentDemoRoleEmails[role];
  const completeDemoMfa = developmentDemoMfaRoles.has(role);
  if (completeDemoMfa && !serviceRoleKey)
    return privateJson({ error: 'DEMO_MFA_UNAVAILABLE' }, 503);

  if (completeDemoMfa) {
    const admin = createClient(url, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id,email')
      .eq('email', demoEmail)
      .maybeSingle();
    if (profileError || !profile || profile.email !== demoEmail)
      return privateJson({ error: 'DEMO_MFA_ACCOUNT_NOT_FOUND' }, 503);

    const { data: factors, error: factorListError } = await admin.auth.admin.mfa.listFactors({
      userId: profile.id,
    });
    if (factorListError) return privateJson({ error: 'DEMO_MFA_RESET_FAILED' }, 503);
    for (const factor of factors.factors) {
      const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
        userId: profile.id,
        id: factor.id,
      });
      if (deleteError) return privateJson({ error: 'DEMO_MFA_RESET_FAILED' }, 503);
    }
  }

  const response = privateJson({ ok: true });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        // Password sign-in and demo MFA verification both rotate auth state in
        // this one request. Keep the request-side view current so the second
        // write removes/replaces the first cookie shape instead of leaving a
        // stale AAL1 base cookie beside the final chunked AAL2 cookie.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });
  const { data: signIn, error } = await supabase.auth.signInWithPassword({
    email: demoEmail,
    password,
  });
  if (error) return privateJson({ error: 'DEMO_LOGIN_REJECTED' }, 401);

  if (completeDemoMfa) {
    if (!signIn.user || signIn.user.email !== demoEmail)
      return privateJson({ error: 'DEMO_MFA_ACCOUNT_MISMATCH' }, 401);
    const { data: enrollment, error: enrollmentError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Development demo login',
    });
    if (enrollmentError) return privateJson({ error: 'DEMO_MFA_ENROLL_FAILED' }, 503);
    const { error: verificationError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrollment.id,
      code: currentTotp(enrollment.totp.secret),
    });
    if (verificationError) return privateJson({ error: 'DEMO_MFA_VERIFY_FAILED' }, 503);

    const { data: assurance, error: assuranceError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance.currentLevel !== 'aal2')
      return privateJson({ error: 'DEMO_MFA_AAL2_REQUIRED' }, 503);
  }

  return response;
}

export function GET() {
  return privateJson({ error: 'METHOD_NOT_ALLOWED', path: DEVELOPMENT_DEMO_ROLE_LOGIN_PATH }, 405);
}
