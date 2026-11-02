import { Injectable } from '@nestjs/common';
import { Order, OrderRepository } from '@shop/domain';

@Injectable()
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async find(id: string) {
    return this.orders.get(id);
  }

  async save(order: Order) {
    this.orders.set(order.id, order);
  }
}
