from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Money:
    """An amount in one currency, in cents."""

    cents: int
    currency: str = "EUR"

    def __add__(self, other: Money) -> Money:
        if other.currency != self.currency:
            raise CurrencyMismatch(self.currency, other.currency)
        return Money(self.cents + other.cents, self.currency)

    def times(self, quantity: int) -> Money:
        return Money(self.cents * quantity, self.currency)

    def percent(self, rate: int) -> Money:
        return Money(self.cents * rate // 100, self.currency)


class CurrencyMismatch(ValueError):
    pass
