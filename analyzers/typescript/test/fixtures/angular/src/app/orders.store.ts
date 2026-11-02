import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PanelState } from './panel.state';

@Injectable({ providedIn: 'root' })
export class OrdersStore {
  constructor(private http: HttpClient, private panel: PanelState) {}

  load() {
    return this.http.get('/api/orders');
  }
}
