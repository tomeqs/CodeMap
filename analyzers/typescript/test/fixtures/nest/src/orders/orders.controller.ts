import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':id')
  find(@Param('id') id: string) {
    return this.orders.find(id);
  }

  @Post()
  create(@Body() body: { lines: number[] }) {
    return this.orders.place(body.lines);
  }
}
