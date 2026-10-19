// API tests import Edge Function helpers that read Deno.env. Vitest stubs the
// global at runtime (vi.stubGlobal); this gives the web typecheck its shape.
declare const Deno: { env: { get(name: string): string | undefined } };
