import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ORDERS_REPOSITORY, OrdersRepository } from './orders.repository';
import { RequestContext } from './request-context';
import { Pricing } from './pricing';
import { Order } from './order.entity';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly repository: OrdersRepository,
    private readonly context: RequestContext,
    @InjectRepository(Order) private readonly orm: Repository<Order>,
    private readonly pricing: Pricing,
    @Optional() private readonly audit?: AuditLog,
  ) {}

  find(id: string) {
    return this.repository.find(id);
  }

  place(lines: number[]) {
    return { user: this.context.user(), total: lines.length * this.pricing.price() };
  }
}

interface AuditLog {
  write(text: string): void;
}
