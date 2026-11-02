import { Entity } from '../common/entity';
import { Money } from '../common/money';

export class Product extends Entity {
  constructor(id: string, readonly name: string, readonly price: Money, private stock = 0) {
    super(id);
  }

  get inStock() {
    return this.stock > 0;
  }

  reserve(quantity: number) {
    if (quantity > this.stock) return false;
    this.stock -= quantity;
    return true;
  }
}
