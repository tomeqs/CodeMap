import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';

@Module({ imports: [CatalogModule, OrdersModule, PaymentsModule] })
export class AppModule {}
