import type { Order } from '../domain/order.js';

export interface OrdersRepository {
  save(order: Order): Promise<void>;
}

export class SqlOrdersRepository implements OrdersRepository {
  async save(order: Order): Promise<void> {
    console.log(order.total());
  }
}
