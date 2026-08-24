import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const toast = readFileSync(join(process.cwd(), 'src/components/ui/toast.tsx'), 'utf8');
const root = toast.slice(
  toast.indexOf('const toastRootClassName'),
  toast.indexOf('function ToastIcon'),
);
const viewport = toast.slice(
  toast.indexOf('<ToastPrimitive.Viewport'),
  toast.indexOf('</ToastPrimitive.Viewport>'),
);

describe('global toast pointer-event contract', () => {
  it('lets the empty fixed viewport pass clicks while keeping visible toasts interactive', () => {
    expect(root).toContain('pointer-events-auto');
    expect(viewport).toContain('pointer-events-none');
  });
});
