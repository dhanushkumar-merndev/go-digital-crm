'use client';

import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { usePathname } from 'next/navigation';

function isAuthRoute(pathname: string) {
  return (
    pathname === '/login' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname === '/auth/invite' ||
    pathname === '/access/mfa'
  );
}

/**
 * Mounted from the persistent root layout instead of an individual auth page.
 * This keeps the Lottie canvas alive while only the auth form route changes.
 */
export function PersistentAuthLottie() {
  const pathname = usePathname();
  if (!isAuthRoute(pathname)) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 left-0 z-10 hidden w-[52.5vw] lg:block"
    >
      <div className="absolute bottom-20 left-1/2 size-[min(58vh,560px)] -translate-x-1/2">
        <DotLottieReact
          src="/Login Character Animation.lottie"
          loop
          autoplay
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
