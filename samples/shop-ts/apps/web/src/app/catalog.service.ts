import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

export interface ProductDto {
  id: string;
  name: string;
  price: number;
}

@Injectable({ providedIn: 'root' })
export class CatalogService {
  constructor(private readonly http: HttpClient) {}

  products() {
    return this.http.get<ProductDto[]>('/catalog');
  }
}
