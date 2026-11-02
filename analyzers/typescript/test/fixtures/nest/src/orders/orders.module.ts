import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { RequestContext } from './request-context';
import { ORDERS_REPOSITORY, SqlOrdersRepository } from './orders.repository';
import { PricingService } from './pricing';
import { Order } from './order.entity';
import { CleanupTask } from './cleanup.task';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    RequestContext,
    CleanupTask,
    AuthGuard,
    { provide: ORDERS_REPOSITORY, useClass: SqlOrdersRepository },
    { provide: 'CLOCK', useValue: () => new Date() },
    { provide: PricingService, useFactory: () => new PricingService() },
  ],
})
export class OrdersModule {}
