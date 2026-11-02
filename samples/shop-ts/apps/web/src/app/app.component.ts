import { Component } from '@angular/core';
import { CartComponent } from './cart.component';
import { CartState } from './cart.state';
import { ProductListComponent } from './product-list.component';

@Component({
  selector: 'shop-root',
  standalone: true,
  imports: [ProductListComponent, CartComponent],
  // The cart lives with this component, not in the root injector.
  providers: [CartState],
  template: '<shop-product-list /><shop-cart />',
})
export class AppComponent {}
