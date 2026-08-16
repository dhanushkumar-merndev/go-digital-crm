import Image from 'next/image';

export function AuthPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen bg-[#f5f7fb] lg:grid-cols-[1.05fr_.95fr]">
      {/* ── Left panel ─────────────────────────────────────────────── */}
      <section className="hidden bg-[#17233d] p-14 text-white lg:flex lg:flex-col justify-between">
        {/* TOP: Tagline text — no logo here */}
        <div className="max-w-xl">
          <p className="text-sm font-semibold text-blue-300">One connected customer journey</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight">
            Turn every dealership enquiry into a well-managed relationship.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-slate-300">
            Secure tenant isolation, role-based workflows, sales operations and post-booking
            coordination in one system.
          </p>
        </div>

        {/* Copyright */}
        <p className="text-xs text-slate-500">© 2026 Go Digital Marketing</p>
      </section>

      {/* ── Right panel ────────────────────────────────────────────── */}
      <section className="grid place-items-center p-6">
        <div className="auth-page-content flex w-full max-w-md flex-col items-center gap-6">
          {/* Logo + brand text at the TOP of right panel */}
          <div className="flex flex-col items-center gap-2 text-center">
            <Image
              src="/logo.webp"
              alt="Go Digital Marketing CRM logo"
              width={52}
              height={52}
              className="rounded-xl object-contain"
              priority
            />
            <div>
              <p className="text-sm font-bold text-[#17233d]">Go Digital Marketing CRM</p>
              <p className="text-xs text-[#17233d]/70">Automobile dealership workspace</p>
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
