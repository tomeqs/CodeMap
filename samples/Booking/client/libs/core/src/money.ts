/** Edge case: overloads. The node keeps the size of the implementation (the last declaration). */
export function formatMoney(amount: number): string;
export function formatMoney(amount: number, currency: string): string;
export function formatMoney(amount: number, currency = 'EUR'): string {
  const rounded = Math.round(amount * 100) / 100;
  if (currency === 'EUR') return `€${rounded.toFixed(2)}`;
  return `${rounded.toFixed(2)} ${currency}`;
}
