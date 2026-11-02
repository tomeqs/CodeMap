import { DomainError } from './domain-error';

/** An amount in one currency. */
export class Money {
  static zero(currency = 'EUR') {
    return new Money(0, currency);
  }

  constructor(readonly amount: number, readonly currency: string) {
    if (amount < 0) throw new DomainError('Money cannot be negative.');
  }

  add(other: Money): Money {
    if (other.currency !== this.currency) throw new DomainError(`Cannot add ${other.currency} to ${this.currency}.`);
    return new Money(this.amount + other.amount, this.currency);
  }

  times(factor: number): Money {
    return new Money(Math.round(this.amount * factor * 100) / 100, this.currency);
  }

  toString() {
    return `${this.amount.toFixed(2)} ${this.currency}`;
  }
}
