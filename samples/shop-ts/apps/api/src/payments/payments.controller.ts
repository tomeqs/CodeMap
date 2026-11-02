import { Body, Controller, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhooks/declined')
  declined(@Body() body: { orderId: string }) {
    return this.payments.declined(body.orderId);
  }
}
