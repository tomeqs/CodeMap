import { Component, inject } from '@angular/core';
import { OrdersStore } from './orders.store';
import { PanelState } from './panel.state';

@Component({ selector: 'app-root', template: '<app-orders />', providers: [PanelState] })
export class AppComponent {
  private readonly store = inject(OrdersStore);
}
