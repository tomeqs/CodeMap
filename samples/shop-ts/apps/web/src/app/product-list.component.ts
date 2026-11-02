import { Component, inject } from '@angular/core';
import { CartState } from './cart.state';
import { CatalogService, ProductDto } from './catalog.service';
import { MoneyPipe } from './money.pipe';

@Component({
  selector: 'shop-product-list',
  standalone: true,
  imports: [MoneyPipe],
  template: '<button *ngFor="let p of products" (click)="add(p)">{{ p.name }} {{ p.price | money }}</button>',
})
export class ProductListComponent {
  private readonly catalog = inject(CatalogService);
  private readonly cart = inject(CartState);
  products: ProductDto[] = [];

  constructor() {
    this.catalog.products().subscribe((products) => (this.products = products));
  }

  add(product: ProductDto) {
    this.cart.add(product);
  }
}
