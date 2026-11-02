import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrdersService, PlaceOrder } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':id')
  async find(@Param('id') id: string) {
    const order = await this.orders.find(id);
    return { id: order.id, status: order.status, items: order.itemCount };
  }

  @Post()
  place(@Body() body: PlaceOrder) {
    return this.orders.place(body);
  }

  @Post(':id/pay')
  pay(@Param('id') id: string) {
    return this.orders.pay(id);
  }
}
