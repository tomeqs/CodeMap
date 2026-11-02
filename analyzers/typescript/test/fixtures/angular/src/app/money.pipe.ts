import { Pipe } from '@angular/core';

@Pipe({ name: 'money' })
export class MoneyPipe {
  transform(value: number) {
    return value.toFixed(2);
  }
}
