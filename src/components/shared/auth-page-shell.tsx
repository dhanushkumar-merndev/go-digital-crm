export function AuthPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen bg-[#f5f7fb] lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden bg-[#17233d] p-14 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-blue-500 text-sm font-black">
            GO
          </div>
          <div>
            <p className="font-bold">Go Digital Marketing CRM</p>
            <p className="text-xs text-slate-400">Automobile dealership workspace</p>
          </div>
        </div>
        <div className="max-w-xl">
          <p className="text-sm font-semibold text-blue-300">One connected customer journey</p>
          <h1 className="mt-4 text-4xl font-bold leading-tight">
            Turn every dealership enquiry into a well-managed relationship.
          </h1>
          <p className="mt-5 max-w-lg text-sm leading-6 text-slate-300">
            Secure tenant isolation, role-based workflows, sales operations and post-booking
            coordination in one system.
          </p>
        </div>
        <p className="text-xs text-slate-500">© 2026 Go Digital Marketing</p>
      </section>
      <section className="grid place-items-center p-6">{children}</section>
    </main>
  );
}
