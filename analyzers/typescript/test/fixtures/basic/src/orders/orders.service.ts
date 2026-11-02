import { Order, OrderError, type OrderId } from '../domain/order.js';
import type { OrdersRepository } from './orders.repository.js';

function log(target: unknown, key: string) {}

export class OrdersService {
  constructor(private readonly repository: OrdersRepository) {}

  @log
  async place(id: OrderId, items: number[]): Promise<Order> {
    if (!items.length) throw new OrderError('empty');
    const order = new Order(id, items);
    await this.repository.save(order);
    return order;
  }
}
