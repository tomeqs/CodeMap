import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { Money, Order } from '@shop/domain';
import { OrdersService } from '../orders/orders.service';
import { PaymentGateway } from './payment-gateway';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(forwardRef(() => OrdersService)) private readonly orders: OrdersService,
    // An interface does not exist at runtime: Nest cannot inject it without a token.
    private readonly gateway: PaymentGateway,
  ) {}

  async charge(order: Order, amount: Money) {
    const accepted = await this.gateway.charge(order.customerId, amount);
    if (!accepted) throw new Error(`The payment of ${amount} for ${order.id} was declined.`);
  }

  async declined(orderId: string) {
    await this.orders.cancel(orderId);
  }
}
