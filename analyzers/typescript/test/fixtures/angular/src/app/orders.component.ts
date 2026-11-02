import { Component, Optional } from '@angular/core';
import { OrdersStore } from './orders.store';
import { PanelState } from './panel.state';

@Component({ selector: 'app-orders', template: '' })
export class OrdersComponent {
  constructor(private store: OrdersStore, @Optional() private panel?: PanelState) {}
}
