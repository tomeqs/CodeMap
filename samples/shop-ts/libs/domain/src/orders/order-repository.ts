import { Order } from './order';

export interface OrderRepository {
  find(id: string): Promise<Order | undefined>;
  save(order: Order): Promise<void>;
}
