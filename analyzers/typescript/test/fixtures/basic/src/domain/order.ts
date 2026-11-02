export type OrderId = string;

export const MAX_ITEMS = 100;

/** An order of a customer. More text here. */
export class Order {
  constructor(public readonly id: OrderId, private items: number[]) {}

  total(): number {
    let sum = 0;
    for (const item of this.items) {
      if (item > 0 && item < MAX_ITEMS) sum += item;
    }
    return sum;
  }
}

export class OrderError extends Error {}

function unusedHelper(x: number): number {
  return x > 0 ? x : -x;
}
