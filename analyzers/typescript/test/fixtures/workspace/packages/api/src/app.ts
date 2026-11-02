import { Money } from '@shop/domain';
import { format } from '@app/util/format';
import { z } from 'zod';

export function total(a: number, b: number): string {
  const sum = new Money(a).add(new Money(b));
  return format(sum.amount);
}
