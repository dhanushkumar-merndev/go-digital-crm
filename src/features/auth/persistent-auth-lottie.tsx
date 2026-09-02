'use client';

import { DotLottieReact } from '@lottiefiles/dotlottie-react';

export function AuthIllustration() {
  return (
    <div className="flex w-full items-center justify-center my-auto min-h-0 py-1">
      <div className="w-full max-w-[min(32vh,300px)] lg:max-w-[min(35vh,350px)] xl:max-w-[min(40vh,420px)] 2xl:max-w-[min(45vh,480px)] aspect-square flex items-center justify-center">
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

export function PersistentAuthLottie() {
  return null;
}
