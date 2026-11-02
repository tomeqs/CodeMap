import { Module, forwardRef } from '@nestjs/common';
import { BulkDiscount, LoyaltyDiscount } from '@shop/domain';
import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { InMemoryOrderRepository } from './in-memory-order.repository';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { RequestContext } from './request-context';
import { CLOCK, DISCOUNT_POLICIES, ORDER_REPOSITORY } from './tokens';

@Module({
  imports: [CatalogModule, forwardRef(() => PaymentsModule)],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    RequestContext,
    { provide: ORDER_REPOSITORY, useClass: InMemoryOrderRepository },
    { provide: CLOCK, useValue: { now: () => new Date() } },
    { provide: DISCOUNT_POLICIES, useFactory: () => [new BulkDiscount(), new LoyaltyDiscount(new Set(['c-42']))] },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
