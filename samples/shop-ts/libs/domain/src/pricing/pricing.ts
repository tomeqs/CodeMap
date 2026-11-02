import { Money } from '../common/money';
import { Order } from '../orders/order';

export interface DiscountPolicy {
  /** The share taken off the order, 0 to 1. */
  discount(order: Order): number;
}

export class BulkDiscount implements DiscountPolicy {
  discount(order: Order) {
    return order.itemCount >= 10 ? 0.1 : 0;
  }
}

export class LoyaltyDiscount implements DiscountPolicy {
  constructor(private readonly loyalCustomers: ReadonlySet<string>) {}

  discount(order: Order) {
    return this.loyalCustomers.has(order.customerId) ? 0.05 : 0;
  }
}

/** The price of an order: its subtotal with the best discount that applies. */
export function priceOf(order: Order, policies: DiscountPolicy[]): Money {
  const best = Math.max(0, ...policies.map((policy) => policy.discount(order)));
  return order.subtotal().times(1 - best);
}
