import { Injectable, NotFoundException } from '@nestjs/common';
import { Money, Product } from '@shop/domain';

@Injectable()
export class CatalogService {
  private readonly products = new Map<string, Product>([
    ['p1', new Product('p1', 'Keyboard', new Money(49, 'EUR'), 20)],
    ['p2', new Product('p2', 'Mouse', new Money(19, 'EUR'), 50)],
  ]);

  list() {
    return [...this.products.values()];
  }

  get(id: string) {
    const product = this.products.get(id);
    if (!product) throw new NotFoundException(`No product ${id}.`);
    return product;
  }
}
