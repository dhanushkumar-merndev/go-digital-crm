export type CreditEntry = { amount: number; referenceId: string };

export function deriveBalance(entries: ReadonlyArray<CreditEntry>) {
  return entries.reduce((balance, entry) => balance + entry.amount, 0);
}

export function canConsume(entries: ReadonlyArray<CreditEntry>, requestedAmount: number) {
  return (
    Number.isSafeInteger(requestedAmount) &&
    requestedAmount > 0 &&
    deriveBalance(entries) >= requestedAmount
  );
}
