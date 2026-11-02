import { Product } from '../catalog/product';
import { DomainError } from '../common/domain-error';
import { Entity } from '../common/entity';
import { Money } from '../common/money';

export type OrderStatus = 'draft' | 'placed' | 'paid' | 'cancelled';

export interface OrderLine {
  product: Product;
  quantity: number;
}

export class Order extends Entity {
  private readonly lines: OrderLine[] = [];
  status: OrderStatus = 'draft';

  constructor(id: string, readonly customerId: string) {
    super(id);
  }

  get itemCount() {
    return this.lines.reduce((count, line) => count + line.quantity, 0);
  }

  addLine(product: Product, quantity: number) {
    if (this.status !== 'draft') throw new DomainError('Only a draft order can change.');
    if (quantity <= 0) throw new DomainError('Quantity must be positive.');
    if (!product.reserve(quantity)) throw new DomainError(`${product.name} is out of stock.`);
    const existing = this.lines.find((line) => line.product.equals(product));
    if (existing) existing.quantity += quantity;
    else this.lines.push({ product, quantity });
  }

  subtotal(): Money {
    return this.lines.reduce((sum, line) => sum.add(line.product.price.times(line.quantity)), Money.zero());
  }

  place() {
    if (!this.lines.length) throw new DomainError('An empty order cannot be placed.');
    this.status = 'placed';
  }

  markPaid() {
    if (this.status !== 'placed') throw new DomainError('Only a placed order can be paid.');
    this.status = 'paid';
  }

  cancel() {
    if (this.status === 'paid') throw new DomainError('A paid order cannot be cancelled.');
    this.status = 'cancelled';
  }
}
