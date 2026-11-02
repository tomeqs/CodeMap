import { Injectable } from '@nestjs/common';
import { Money } from '@shop/domain';

export interface PaymentGateway {
  charge(customerId: string, amount: Money): Promise<boolean>;
}

@Injectable()
export class FakePaymentGateway implements PaymentGateway {
  async charge(customerId: string, amount: Money) {
    return amount.amount < 10_000;
  }
}
