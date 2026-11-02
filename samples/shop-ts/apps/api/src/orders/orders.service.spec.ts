import { Test } from '@nestjs/testing';
import { OrdersModule } from './orders.module';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  it('prices a placed order with the best discount', async () => {
    const module = await Test.createTestingModule({ imports: [OrdersModule] }).compile();
    const orders = await module.resolve(OrdersService);
    const placed = await orders.place({ lines: [{ productId: 'p2', quantity: 10 }] });
    expect(placed.total).toBe('171.00 EUR');
  });
});
