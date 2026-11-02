import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { DiscountPolicy, DomainError, Order, OrderRepository, priceOf } from '@shop/domain';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { RequestContext } from './request-context';
import { CLOCK, Clock, DISCOUNT_POLICIES, ORDER_REPOSITORY } from './tokens';

export interface PlaceOrder {
  lines: { productId: string; quantity: number }[];
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly catalog: CatalogService,
    // Request-scoped: Nest makes this service request-scoped too (a new one for every request).
    private readonly context: RequestContext,
    // Orders and payments need each other: forwardRef breaks the circle for Nest, not for the design.
    @Inject(forwardRef(() => PaymentsService)) private readonly payments: PaymentsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DISCOUNT_POLICIES) private readonly discounts: DiscountPolicy[],
  ) {}

  async find(id: string) {
    const order = await this.orders.find(id);
    if (!order) throw new DomainError(`No order ${id}.`);
    return order;
  }

  async place(command: PlaceOrder) {
    const order = new Order(`o-${this.clock.now().getTime()}`, this.context.customerId());
    for (const line of command.lines) order.addLine(this.catalog.get(line.productId), line.quantity);
    order.place();
    await this.orders.save(order);
    return { id: order.id, total: priceOf(order, this.discounts).toString() };
  }

  async pay(id: string) {
    const order = await this.find(id);
    await this.payments.charge(order, priceOf(order, this.discounts));
    order.markPaid();
    await this.orders.save(order);
  }

  async cancel(id: string) {
    const order = await this.find(id);
    order.cancel();
    await this.orders.save(order);
  }

  // Nobody calls this any more.
  private legacyTotal(order: Order) {
    return order.subtotal().amount * 1.23;
  }
}
