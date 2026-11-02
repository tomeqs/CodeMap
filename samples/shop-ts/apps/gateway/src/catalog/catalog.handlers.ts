import type { Request, Response } from 'express';
import { Money } from '@shop/domain';
import { api } from '../api-client';

interface ProductDto {
  id: string;
  name: string;
  price: number;
}

export async function listProducts(req: Request, res: Response) {
  const products = (await api.get<ProductDto[]>('/products')) ?? [];
  res.json(products.map(withPrice));
}

export async function productById(id: string) {
  const product = await api.get<ProductDto>(`/products/${encodeURIComponent(id)}`);
  return product && withPrice(product);
}

function withPrice(product: ProductDto) {
  return { ...product, price: new Money(product.price, 'EUR').toString() };
}
