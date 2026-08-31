import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const gate = readFileSync('src/features/auth/mfa-gate.tsx', 'utf8');

describe('MFA gate interaction', () => {
  it('focuses the verification field and verifies on Enter', () => {
    expect(gate).toContain('autoFocus');
    expect(gate).toContain('onSubmit={(event) => {');
    expect(gate).toContain('event.preventDefault();');
    expect(gate).toContain('void verify();');
    expect(gate).toContain('type="submit"');
  });
});
