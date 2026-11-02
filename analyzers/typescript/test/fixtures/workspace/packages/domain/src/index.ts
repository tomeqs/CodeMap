export class Money {
  constructor(public readonly amount: number) {}
  add(other: Money): Money {
    return new Money(this.amount + other.amount);
  }
}
