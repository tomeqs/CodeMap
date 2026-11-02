import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CartState } from './cart.state';

// An application-wide service that needs the cart, which only AppComponent provides: the root injector cannot give it.
@Injectable({ providedIn: 'root' })
export class CheckoutService {
  constructor(private readonly http: HttpClient, private readonly cart: CartState) {}

  checkout() {
    const lines = this.cart.lines.map((line) => ({ productId: line.productId, quantity: line.quantity }));
    return this.http.post<{ id: string; total: string }>('/orders', { lines });
  }
}
