import { Pipe, PipeTransform } from '@angular/core';
import { Money } from '@shop/domain';

@Pipe({ name: 'money', standalone: true })
export class MoneyPipe implements PipeTransform {
  transform(value: number) {
    return new Money(value, 'EUR').toString();
  }
}
