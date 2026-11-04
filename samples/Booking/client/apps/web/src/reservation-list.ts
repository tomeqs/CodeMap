import { component, formatMoney, HttpClient, type ReservationDto } from '@booking/core';
import { formatNights } from '@/util/dates';

/** Edge case: the decorator's template holds parentheses; the signature is still `export class ReservationList extends HttpClient`. */
@component({ selector: 'reservation-list', template: '<button (click)="reload()">Reload</button><ul></ul>' })
export class ReservationList extends HttpClient {
  private items: ReservationDto[] = [];

  async reload(): Promise<void> {
    this.items = await this.get<ReservationDto[]>('/reservations');
  }

  render(): HTMLElement {
    const ul = document.createElement('ul');
    for (const item of this.items) {
      const li = document.createElement('li');
      li.textContent = `${item.room} · ${item.guest} · ${formatNights(item.nights)} · ${formatMoney(item.nights * 120)}`;
      ul.append(li);
    }

    return ul;
  }
}
