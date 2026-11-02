import { Injectable } from '@angular/core';
import { Money } from '@shop/domain';

export interface CartLine {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

@Injectable()
export class CartState {
  readonly lines: CartLine[] = [];

  add(product: { id: string; name: string; price: number }) {
    const line = this.lines.find((l) => l.productId === product.id);
    if (line) line.quantity++;
    else this.lines.push({ productId: product.id, name: product.name, price: product.price, quantity: 1 });
  }

  total() {
    return this.lines.reduce((sum, line) => sum.add(new Money(line.price, 'EUR').times(line.quantity)), Money.zero());
  }
}
