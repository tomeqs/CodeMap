import { OrdersService } from './orders.service.js';
export function test() {
  return new OrdersService({ save: async () => {} });
}
