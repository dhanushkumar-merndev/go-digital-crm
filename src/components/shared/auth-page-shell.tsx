import Image from 'next/image';
import { AuthIllustration } from '@/features/auth/persistent-auth-lottie';

export function AuthPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen min-h-[100dvh] lg:h-screen lg:h-[100dvh] w-full bg-[#f5f7fb] overflow-y-auto lg:overflow-hidden">
      {/* ── Left panel (Desktop / Laptop 50% full height blue) ─────── */}
      <section className="relative hidden w-1/2 flex-col justify-between bg-[#17233d] p-6 lg:p-8 xl:p-12 2xl:p-14 text-white lg:flex h-full overflow-hidden shrink-0 select-none">
        {/* TOP: Tagline text */}
        <div className="relative z-10 max-w-md xl:max-w-xl shrink-0">
          <p className="text-xs xl:text-sm font-semibold text-blue-300">One connected customer journey</p>
          <h1 className="mt-2 xl:mt-3 text-2xl lg:text-3xl xl:text-4xl font-bold leading-tight tracking-tight">
            Turn every dealership enquiry into a well-managed relationship.
          </h1>
          <p className="mt-2 xl:mt-3 text-xs xl:text-sm leading-relaxed text-slate-300">
            Secure tenant isolation, role-based workflows, sales operations and post-booking
            coordination in one system.
          </p>
        </div>

        {/* CENTER: Lottie Character Illustration (dynamically scaled to fit viewport height) */}
        <div className="relative z-10 my-auto flex w-full items-center justify-center min-h-0 py-1 xl:py-2">
          <AuthIllustration />
        </div>

        {/* BOTTOM: Copyright */}
        <p className="relative z-10 text-[11px] xl:text-xs text-slate-400 shrink-0">© 2026 Go Digital Marketing</p>
      </section>

      {/* ── Right panel (Light background with centered auth card) ── */}
      <section className="flex flex-1 flex-col items-center justify-center min-h-screen lg:min-h-0 lg:h-full w-full p-4 sm:p-6 lg:p-8 bg-[#f5f7fb] overflow-y-auto">
        <div className="auth-page-content flex w-full max-w-[390px] xl:max-w-[420px] flex-col items-center gap-4 xl:gap-6 my-auto py-4 sm:py-6">
          {/* Logo + brand text at the TOP of right panel */}
          <div className="flex flex-col items-center gap-1.5 text-center shrink-0">
            <Image
              src="/logo.webp"
              alt="Go Digital Marketing CRM logo"
              width={48}
              height={48}
              className="size-10 xl:size-12 rounded-xl object-contain shadow-sm"
              priority
            />
            <div>
              <p className="text-sm xl:text-base font-bold text-[#17233d]">Go Digital Marketing CRM</p>
              <p className="text-[11px] xl:text-xs text-[#17233d]/70">Automobile dealership workspace</p>
            </div>
          </div>

          {/* The stable view-transition name lets auth cards resize/morph
              smoothly when users move between Login, Forgot Password, Reset,
              Invite, and MFA. */}
          <div className="auth-card-transition w-full">{children}</div>
        </div>
      </section>
    </main>
  );
}
