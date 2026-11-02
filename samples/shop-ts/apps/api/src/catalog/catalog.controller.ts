import { Controller, Get, Param } from '@nestjs/common';
import { Product } from '@shop/domain';
import { CatalogService } from './catalog.service';

@Controller('products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list() {
    return this.catalog.list().map(toDto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return toDto(this.catalog.get(id));
  }
}

function toDto(product: Product) {
  return { id: product.id, name: product.name, price: product.price.toString(), inStock: product.inStock };
}
