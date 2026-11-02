import { Injectable } from '@nestjs/common';

export const ORDERS_REPOSITORY = Symbol('ORDERS_REPOSITORY');

export interface OrdersRepository {
  find(id: string): Promise<unknown>;
}

@Injectable()
export class SqlOrdersRepository implements OrdersRepository {
  async find(id: string) {
    return { id };
  }
}
