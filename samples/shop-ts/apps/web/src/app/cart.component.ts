import { Component } from '@angular/core';
import { CartState } from './cart.state';
import { CheckoutService } from './checkout.service';

@Component({
  selector: 'shop-cart',
  standalone: true,
  template: '<p>{{ cart.lines.length }} items, {{ cart.total() }}</p><button (click)="pay()">Order</button>',
})
export class CartComponent {
  constructor(readonly cart: CartState, private readonly checkout: CheckoutService) {}

  pay() {
    this.checkout.checkout().subscribe();
  }
}
