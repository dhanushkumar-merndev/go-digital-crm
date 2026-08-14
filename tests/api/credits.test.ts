import { describe, expect, it } from 'vitest';
import { canConsume, deriveBalance } from '../../src/lib/credits/ledger';

describe('append-only credit ledger', () => {
  const entries = [
    { amount: 1000, referenceId: 'allocation-1' },
    { amount: -125, referenceId: 'call-summary-1' },
    { amount: 25, referenceId: 'reversal-1' },
  ];
  it('derives the balance from transactions', () => expect(deriveBalance(entries)).toBe(900));
  it('prevents overspending and invalid amounts', () => {
    expect(canConsume(entries, 901)).toBe(false);
    expect(canConsume(entries, 900)).toBe(true);
    expect(canConsume(entries, -1)).toBe(false);
  });
});
